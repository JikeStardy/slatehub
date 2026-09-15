#include "scenes/bg_refresh/bg_refresh_scene.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <array>
#include <atomic>
#include <cstring>
#include <memory>
#include <new>
#include <vector>

#include "bsp/board.h"
#include "bsp/board_platform.h"
#include "events/event_bus.h"
#include "power/power_state.h"
#include "scenes/bg_refresh/bg_refresh_transaction.h"
#include "storage/cache/cache.h"
#include "ui/status_bar.h"
#include "ui/theme.h"

namespace {
constexpr char kTag[] = "bg_refresh";

// 后台刷新整体硬截止：从进场到完成的总时长上限。WiFi 连接 + poll + 拉帧 + EPD 刷新
// 都算在内。超时直接投 kBgRefreshDone 回睡，不再依赖 10min idle Tick 兜底，封住
// 「sync 卡住 → 持续亮屏连网耗电」的窗口。
constexpr int kBgRefreshDeadlineMs = 40000;
constexpr TickType_t kBgRefreshPostTimeoutTicks = pdMS_TO_TICKS(50);
constexpr int        kBgRefreshPostAttempts     = 3;
constexpr int        kBgRefreshClaimAttempts    = 64;
uint64_t             s_bg_refresh_generation     = 0;

bool PostBgRefreshDone(uint64_t generation, TickType_t timeout = kBgRefreshPostTimeoutTicks) {
    UiEvent e{};
    e.kind                    = UiEventKind::kBgRefreshDone;
    e.u.bg_refresh.generation = generation;
    if (evt::Post(e, timeout))
        return true;
    ESP_LOGW(kTag, "post done failed generation=%llu", static_cast<unsigned long long>(generation));
    return false;
}

bool PostBgRefreshDisplayIdle(uint64_t generation) {
    UiEvent e{};
    e.kind                    = UiEventKind::kBgRefreshDisplayIdle;
    e.u.bg_refresh.generation = generation;
    if (evt::Post(e, kBgRefreshPostTimeoutTicks))
        return true;
    ESP_LOGW(kTag, "post display idle failed generation=%llu", static_cast<unsigned long long>(generation));
    return false;
}

void YieldCompletionContention() {
    vTaskDelay(pdMS_TO_TICKS(20));
}

bool IsFinished(const std::shared_ptr<bg_refresh::CompletionState>& state) {
    return !state || bg_refresh::IsTerminal(state->state.load(std::memory_order_acquire));
}

void UpdateFrameSchedule(int seq, const cache::FrameMeta& meta) {
    power_state::SetCurrentFrameFromMeta(seq, meta);
}

struct WatcherContext {
    display::Display*                            display = nullptr;
    std::shared_ptr<bg_refresh::CompletionState> completion;
};

void WatcherEntry(void* arg) {
    std::unique_ptr<WatcherContext> ctx(static_cast<WatcherContext*>(arg));
    auto*                           display = ctx ? ctx->display : nullptr;
    auto                            state   = ctx ? ctx->completion : std::shared_ptr<bg_refresh::CompletionState>();
    constexpr int                   kTimeoutMs = 8000;
    bg_refresh::RunWatcherCompletion(
        state,
        [display]() { return display && display->WaitForRefreshIdle(kTimeoutMs); },
        [&ctx, &state]() {
            ctx.reset();
            state.reset();
        },
        [](uint64_t generation) { return PostBgRefreshDisplayIdle(generation); },
        [](uint64_t generation) { return PostBgRefreshDone(generation); },
        []() { YieldCompletionContention(); },
        kBgRefreshPostAttempts);
    vTaskDelete(nullptr);
}

// 截止看护任务：等到 kBgRefreshDeadlineMs；其间一旦 completion 终态(正常 finish)就提前退出，
// 否则到点通过状态机取得完成权并投递 kBgRefreshDone。FreeRTOS vTaskDelete(nullptr) 不会展开
// 当前 C++ 栈，因此所有 C++ owning locals 必须在自删前显式 reset。
void DeadlineEntry(void* arg) {
    std::unique_ptr<WatcherContext> ctx(static_cast<WatcherContext*>(arg));
    auto                            state  = ctx ? ctx->completion : std::shared_ptr<bg_refresh::CompletionState>();
    int                             waited = 0;
    while (waited < kBgRefreshDeadlineMs && !IsFinished(state)) {
        vTaskDelay(pdMS_TO_TICKS(200));
        waited += 200;
    }
    const bool timed_out = !IsFinished(state);
    if (timed_out) {
        ESP_LOGW(kTag, "deadline reached elapsed_ms=%d action=force_done", kBgRefreshDeadlineMs);
        // 不在此处 RecordTimerWakeResult：与 OnEvent 的上报存在时序竞态(渲染跨过截止时
        // 会先 true 再 false 重复计数)。失败退避由「连不上服务器」(app.cc net_ok=false)与
        // OnEvent 的 kSyncFinished(ok) 覆盖；「连上但每次卡满截止」是罕见失败模式，
        // 仅靠 40s 截止回睡兜底、不计入退避（已知次要限制）。
    }
    auto state_for_retry = state;
    ctx.reset();
    state.reset();
    bg_refresh::RunDeadlineRetryLoop(
        state_for_retry,
        [&state_for_retry]() { return IsFinished(state_for_retry); },
        [](uint64_t generation) { return PostBgRefreshDone(generation); },
        []() { YieldCompletionContention(); },
        kBgRefreshPostAttempts,
        kBgRefreshClaimAttempts);
    state_for_retry.reset();
    vTaskDelete(nullptr);
}

}  // namespace

BgRefreshScene::~BgRefreshScene() = default;

void BgRefreshScene::OnEnter(SceneContext& ctx) {
    completion_            = std::make_shared<bg_refresh::CompletionState>(
        bg_refresh::NextGeneration(s_bg_refresh_generation));
    force_full_refresh_     = false;
    previous_screen_seeded_ = SeedPreviousFrame(ctx);
    state_                  = State::kWaiting;
    ClearPendingFrameCommit();
    StartDeadlineWatchdog();
}

void BgRefreshScene::StartDeadlineWatchdog() {
    auto* ctx = new (std::nothrow) WatcherContext{nullptr, completion_};
    if (!ctx) {
        ESP_LOGW(kTag, "deadline watchdog alloc failed");
        return;  // 退化到 SleepManager 的 idle/看门狗兜底
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&DeadlineEntry, "bg_refresh_deadline", 2048, ctx, 2, nullptr, 0);
    if (ok != pdPASS) {
        delete ctx;
        ESP_LOGW(kTag, "deadline watchdog create failed");
    }
}

void BgRefreshScene::OnExit(SceneContext& ctx) {
    bg_refresh::Cancel(completion_.get());
    completion_.reset();
    ClearPendingFrameCommit();
    DestroyRoot(ctx, root_, [this] { status_bar_.reset(); });
}

void BgRefreshScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (e.kind == UiEventKind::kBgRefreshDisplayIdle) {
        if (!completion_ || e.u.bg_refresh.generation != completion_->generation) {
            ESP_LOGW(kTag, "display idle ignored reason=generation_mismatch event=%llu current=%llu",
                     static_cast<unsigned long long>(e.u.bg_refresh.generation),
                     static_cast<unsigned long long>(completion_ ? completion_->generation : 0));
            return;
        }
        if (state_ != State::kRendering || !pending_frame_commit_) {
            ESP_LOGW(kTag, "display idle ignored reason=no_pending_commit");
            return;
        }

        const bool completed = bg_refresh::CompleteIdleOnUiTask(
            *completion_,
            e.u.bg_refresh.generation,
            [this]() {
                UpdateFrameSchedule(pending_seq_, pending_meta_);
                ClearPendingFrameCommit();
            },
            [this](uint64_t /*generation*/) { MarkCompleted(); });
        if (!completed)
            ESP_LOGW(kTag, "display idle ignored reason=state_mismatch");
        return;
    }

    if (e.kind != UiEventKind::kSyncFinished || state_ != State::kWaiting)
        return;

    // 上报本次 timer wake 的联网结果：ok 清零退避计数，失败递增。配合 app.cc 网络
    // 建立失败分支，让持续不可达的设备指数拉长唤醒间隔，而非每 ttl 空醒。
    power_state::RecordTimerWakeResult(e.u.sync.ok);

    if (!e.u.sync.ok || !e.u.sync.group_changed) {
        Finish();
        return;
    }

    if (!previous_screen_seeded_) {
        ESP_LOGW(kTag, "render skipped reason=previous_seed_incomplete");
        Finish();
        return;
    }

    state_ = State::kRendering;
    if (!RenderChangedFrame(ctx)) {
        Finish();
    }
}

bool BgRefreshScene::SeedPreviousFrame(SceneContext& ctx) {
    if (!ctx.epd)
        return false;
    const board::BoardPlatform&     platform = Board::Get().platform();
    const display::FrameDescriptor& frame    = ctx.epd->Info().frame;
    if (!display::ValidateFrameDescriptor(frame))
        return false;
    const int                      bpr = frame.width / 8;
    const display::FrameRegion     status_region = platform.StatusBarSnapshotRegion();
    const std::size_t              status_bytes  = platform.StatusBarSnapshotBytes();

    if (!ctx.epd->Info().capabilities.previous_frame_seed) {
        ESP_LOGW(kTag, "seed skipped reason=unsupported action=full_refresh");
        force_full_refresh_ = true;
        return true;
    }

    std::array<uint8_t, board::kStatusBarSnapshotCapacityBytes> status_bar{};
    if (status_bytes == 0 || status_bytes > status_bar.size() || !display::ValidateRegion(status_region, frame)) {
        ESP_LOGW(kTag, "seed skipped reason=status_snapshot_shape");
        return false;
    }
    const bool status_ok =
        power_state::LoadStatusBarSnapshot(ctx.epd->Info(), status_region, status_bar.data(), status_bytes);
    if (!status_ok) {
        ESP_LOGW(kTag, "seed skipped reason=status_snapshot_missing");
        return false;
    }

    std::string gid;
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ESP_LOGW(kTag, "seed skipped reason=cached_group_missing");
        return false;
    }

    int content_count = 0;
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ESP_LOGW(kTag, "seed skipped reason=manifest_missing");
        return false;
    }

    const int seq = power_state::GetCurrentFrameSeq();
    if (seq < 0 || seq >= content_count) {
        ESP_LOGW(kTag, "seed skipped reason=seq_out_of_range seq=%d count=%d", seq, content_count);
        return false;
    }

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid, seq, raw) || raw.size() != frame.byte_size) {
        ESP_LOGW(kTag, "seed skipped reason=image_miss seq=%d bytes=%u", seq, static_cast<unsigned>(raw.size()));
        return false;
    }

    const int y = theme::kStatusBarHeight;
    const display::FrameRegion body_region{0, y, frame.width, frame.height - y};
    const std::size_t          body_bytes = display::ExpectedRegionBytes(body_region, frame);
    return display::SeedPreviousIfSupported(*ctx.epd, status_region, status_bar.data(), status_bytes) &&
           display::SeedPreviousIfSupported(*ctx.epd, body_region, raw.data() + y * bpr, body_bytes);
}

bool BgRefreshScene::ResolveCurrentFrame(std::string& gid, int& seq, int& content_count) {
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ESP_LOGW(kTag, "render skipped reason=cached_group_missing");
        return false;
    }
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ESP_LOGW(kTag, "render skipped reason=manifest_missing");
        return false;
    }

    seq = power_state::GetCurrentFrameSeq();
    if (seq < 0 || seq >= content_count) {
        seq = 0;
    }
    return true;
}

bool BgRefreshScene::RenderChangedFrame(SceneContext& ctx) {
    if (!ctx.epd)
        return false;
    const display::FrameDescriptor& frame = ctx.epd->Info().frame;
    if (!display::ValidateFrameDescriptor(frame))
        return false;

    std::string gid;
    int         seq           = 0;
    int         content_count = 0;
    if (!ResolveCurrentFrame(gid, seq, content_count))
        return false;

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid, seq, raw) || raw.size() != frame.byte_size) {
        ESP_LOGW(kTag, "render skipped reason=image_miss seq=%d bytes=%u", seq, static_cast<unsigned>(raw.size()));
        return false;
    }

    cache::FrameMeta meta;
    cache::ReadFrameMeta(gid, seq, meta);

    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "render failed reason=epd_lock_timeout");
        return false;
    }

    root_ = CreateFullscreenRoot();
    lv_obj_set_height(root_, theme::kStatusBarHeight);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption(meta.status_bar_text);
    RefreshStatusBarFromSensors(ctx, *status_bar_);
    lv_refr_now(NULL);

    // Background refresh uses LVGL only for the status bar. The frame body is
    // written as raw 1bpp data so it exactly matches the cached screen format.
    const int y = theme::kStatusBarHeight;
    const int bpr = frame.width / 8;
    const display::FrameRegion body_region{0, y, frame.width, frame.height - y};
    const display::PresentMode mode =
        force_full_refresh_ ? display::PresentMode::kFull : display::PresentMode::kPartial;
    if (!display::PresentWithFallback(*ctx.epd, body_region, raw.data() + y * bpr,
                                      display::ExpectedRegionBytes(body_region, frame), mode)) {
        ctx.epd->Unlock();
        ESP_LOGW(kTag, "render failed reason=display_present_request_rejected");
        return false;
    }
    ctx.epd->Unlock();

    pending_frame_commit_ = true;
    pending_seq_          = seq;
    pending_meta_         = meta;
    StartWatcher(ctx.epd);
    return true;
}

void BgRefreshScene::StartWatcher(display::Display* display) {
    auto* ctx = new (std::nothrow) WatcherContext{display, completion_};
    if (!ctx) {
        ESP_LOGW(kTag, "watcher alloc failed action=finish");
        Finish();
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&WatcherEntry, "bg_refresh_watch", 2048, ctx, 2, nullptr, 0);
    if (ok != pdPASS) {
        delete ctx;
        ESP_LOGW(kTag, "watcher create failed action=finish");
        Finish();
    }
}

void BgRefreshScene::Finish() {
    if (state_ == State::kDone)
        return;
    ClearPendingFrameCommit();
    if (!completion_ ||
        !bg_refresh::QueueDoneEvent(
            completion_,
            [](uint64_t generation) { return PostBgRefreshDone(generation, evt::kNoWait); },
            []() {},
            kBgRefreshPostAttempts,
            1)) {
        return;
    }
}

void BgRefreshScene::MarkCompleted() {
    if (state_ == State::kDone)
        return;
    state_ = State::kDone;
    ClearPendingFrameCommit();
}

void BgRefreshScene::ClearPendingFrameCommit() {
    pending_frame_commit_ = false;
    pending_seq_          = 0;
    pending_meta_         = {};
}

bool BgRefreshScene::IsCompletionGeneration(uint64_t generation) const {
    return completion_ && completion_->generation == generation;
}

bool BgRefreshScene::IsCompletedGeneration(uint64_t generation) const {
    return IsCompletionGeneration(generation) && state_ == State::kDone;
}

bool BgRefreshScene::CompleteDoneEvent(uint64_t generation) {
    if (!completion_)
        return false;
    if (generation == 0) {
        return bg_refresh::CompleteWaitingOnUiTask(
            *completion_, [this](uint64_t /*generation*/) { MarkCompleted(); });
    }
    return bg_refresh::CompleteDoneOnUiTask(
        *completion_, generation, [this](uint64_t /*generation*/) { MarkCompleted(); });
}
