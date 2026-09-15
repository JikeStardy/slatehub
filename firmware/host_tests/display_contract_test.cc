#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <string>

#include "bsp/board_platform.h"
#include "drivers/display/display_contract.h"
#include "power/status_bar_snapshot_identity.h"
#include "scenes/bg_refresh/bg_refresh_transaction.h"
#include "scenes/frame/frame_load_transaction.h"

namespace {

int g_failures = 0;

void Check(bool ok, const char* expr, int line) {
    if (ok)
        return;
    std::fprintf(stderr, "CHECK failed line=%d expr=%s\n", line, expr);
    ++g_failures;
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

constexpr display::FrameDescriptor kFakeFrame{
    296, 128, display::PixelFormat::kMono1, display::FrameCodec::kRawMono1Msb, 4736};
constexpr display::DisplayInfo kFakeDisplayInfo{
    "fake-board-296x128", "fake-board-296x128-mono", kFakeFrame, {false, true, true}};
constexpr display::FrameRegion kFakeStatusRegion{0, 0, 296, 24};

class FakePlatform final : public board::BoardPlatform {
   public:
    const char* BoardId() const override {
        return kFakeDisplayInfo.board_id;
    }

    const char* LegacyUserAgentBoardName() const override {
        return "fake-board-legacy";
    }

    const display::DisplayInfo& Display() const override {
        return kFakeDisplayInfo;
    }

    display::FrameRegion StatusBarSnapshotRegion() const override {
        return kFakeStatusRegion;
    }

    std::size_t StatusBarSnapshotBytes() const override {
        return display::ExpectedRegionBytes(kFakeStatusRegion, kFakeFrame);
    }
};

class FakeDisplay final : public display::Display {
   public:
    explicit FakeDisplay(const display::DisplayInfo& info) : info_(info) {
    }

    const display::DisplayInfo& Info() const override {
        return info_;
    }

    bool Lock(int /*timeout_ms*/) override {
        ++lock_count;
        return true;
    }

    void Unlock() override {
        ++unlock_count;
    }

    bool WaitForRefreshIdle(int /*timeout_ms*/) override {
        ++wait_count;
        return true;
    }

    void RequestRefresh(display::PresentMode mode) override {
        ++refresh_count;
        last_mode = mode;
    }

    bool Present(const display::FrameRegion& region, const uint8_t* data, std::size_t len,
                 display::PresentMode mode) override {
        ++present_count;
        last_region = region;
        last_len    = len;
        last_mode   = mode;
        return present_result && data != nullptr && len == display::ExpectedRegionBytes(region, info_.frame);
    }

    bool SeedPrevious(const display::FrameRegion& /*region*/, const uint8_t* /*data*/, std::size_t /*len*/) override {
        ++seed_count;
        return seed_result;
    }

    bool ReadPrevious(const display::FrameRegion& /*region*/, uint8_t* out, std::size_t len) override {
        ++read_count;
        if (!out)
            return false;
        std::memset(out, 0xFF, len);
        return true;
    }

    display::DisplayInfo info_;
    bool                 present_result = true;
    bool                 seed_result    = true;
    int                  lock_count    = 0;
    int                  unlock_count  = 0;
    int                  wait_count    = 0;
    int                  refresh_count = 0;
    int                  present_count = 0;
    int                  seed_count    = 0;
    int                  read_count    = 0;
    std::size_t          last_len      = 0;
    display::FrameRegion last_region{};
    display::PresentMode last_mode = display::PresentMode::kFull;
};

struct FrameTransactionFake {
    bool prepare_result = true;
    bool present_result = true;
    int  order          = 0;

    int prepare_order  = 0;
    int lock_order     = 0;
    int caption_order  = 0;
    int present_order  = 0;
    int rollback_order = 0;
    int unlock_order   = 0;
    int commit_order   = 0;

    int         committed_idx = -1;
    int         audio_state   = 7;
    int         state_idx     = 2;
    std::string caption{"old"};

    bool PrepareCandidate(int /*candidate_idx*/) {
        prepare_order = ++order;
        return prepare_result;
    }

    bool LockDisplay() {
        lock_order = ++order;
        return true;
    }

    void ApplyCandidateCaption() {
        caption_order = ++order;
        caption       = "candidate";
    }

    void RenderNow() {
        ++order;
    }

    bool PresentCandidate(display::PresentMode /*mode*/) {
        present_order = ++order;
        return present_result;
    }

    void RestorePreviousCaption() {
        rollback_order = ++order;
        caption        = "old";
    }

    void UnlockDisplay() {
        unlock_order = ++order;
    }

    void CommitAccepted(int candidate_idx) {
        commit_order  = ++order;
        committed_idx = candidate_idx;
        state_idx     = candidate_idx;
        audio_state   = 11;
    }
};

struct BgRefreshTransactionFake {
    bool idle_result  = true;
    int  order        = 0;
    int  unlock_order = 0;
    int  wait_order   = 0;
    int  commit_order = 0;
    int  done_order   = 0;

    void UnlockDisplay() {
        unlock_order = ++order;
    }

    bool WaitForIdle() {
        wait_order = ++order;
        return idle_result;
    }

    void Commit() {
        commit_order = ++order;
    }

    void PostDone() {
        done_order = ++order;
    }
};

struct CleanupProbe {
    bool* destroyed = nullptr;

    explicit CleanupProbe(bool* out) : destroyed(out) {
    }

    ~CleanupProbe() {
        if (destroyed)
            *destroyed = true;
    }

    CleanupProbe(const CleanupProbe&)            = delete;
    CleanupProbe& operator=(const CleanupProbe&) = delete;
};

void TestNote4PlatformInfo() {
    const board::BoardPlatform& platform = board::CurrentPlatform();
    const display::DisplayInfo& info     = platform.Display();

    CHECK(std::strcmp(platform.BoardId(), "zectrix-note4") == 0);
    CHECK(std::strcmp(platform.LegacyUserAgentBoardName(), "zectrix-s3-epaper-4.2") == 0);
    CHECK(platform.StatusBarSnapshotBytes() == 1200);
    CHECK(std::strcmp(info.board_id, "zectrix-note4") == 0);
    CHECK(std::strcmp(info.profile_id, "zectrix-note4-400x300-mono") == 0);
    CHECK(info.frame.width == 400);
    CHECK(info.frame.height == 300);
    CHECK(info.frame.pixel_format == display::PixelFormat::kMono1);
    CHECK(info.frame.codec == display::FrameCodec::kRawMono1Msb);
    CHECK(info.frame.byte_size == 15000);
    CHECK(info.capabilities.audio);
    CHECK(info.capabilities.partial_refresh);
    CHECK(info.capabilities.previous_frame_seed);
    CHECK(display::ValidateFrameDescriptor(info.frame));
}

void TestIndependentFakePlatformInfo() {
    const FakePlatform platform;
    const display::DisplayInfo& info = platform.Display();

    CHECK(std::strcmp(platform.BoardId(), "fake-board-296x128") == 0);
    CHECK(std::strcmp(platform.LegacyUserAgentBoardName(), "fake-board-legacy") == 0);
    CHECK(std::strcmp(info.profile_id, "fake-board-296x128-mono") == 0);
    CHECK(info.frame.width == 296);
    CHECK(info.frame.height == 128);
    CHECK(info.frame.byte_size == 4736);
    CHECK(platform.StatusBarSnapshotRegion().height == 24);
    CHECK(platform.StatusBarSnapshotBytes() == 296 * 24 / 8);
}

void TestDescriptorByteSizeValidation() {
    using display::FrameCodec;
    using display::FrameDescriptor;
    using display::PixelFormat;

    constexpr FrameDescriptor note4{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15000};
    static_assert(display::ExpectedFrameBytes(note4) == 15000, "Note4 frame bytes");
    static_assert(display::ValidateFrameDescriptor(note4), "Note4 descriptor is valid");

    constexpr FrameDescriptor zero_width{0, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 0};
    static_assert(!display::ValidateFrameDescriptor(zero_width), "zero width rejected");

    constexpr FrameDescriptor non_aligned{401, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15100};
    static_assert(!display::ValidateFrameDescriptor(non_aligned), "non-byte-aligned mono width rejected");

    constexpr FrameDescriptor unsupported_format{400, 300, PixelFormat::kGray2, FrameCodec::kRawMono1Msb, 30000};
    static_assert(!display::ValidateFrameDescriptor(unsupported_format), "unsupported format rejected");

    constexpr FrameDescriptor wrong_size{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 14999};
    static_assert(!display::ValidateFrameDescriptor(wrong_size), "wrong byte size rejected");

    constexpr FrameDescriptor overflow{524288, 65537, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 65536};
    static_assert(!display::ValidateFrameDescriptor(overflow), "32-bit overflow descriptor rejected");

    std::size_t out = 123;
    CHECK(!display::CheckedAdd(1, static_cast<std::size_t>(std::numeric_limits<uint32_t>::max()) + 1, &out));
    CHECK(out == 123);
}

void TestCapabilityDegradeHelpers() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.partial_refresh      = false;
    info.capabilities.previous_frame_seed  = false;
    FakeDisplay display{info};

    const display::FrameRegion region{0, 24, 296, 104};
    uint8_t                    body[296 * 104 / 8] = {};
    uint8_t                    snapshot[296 * 24 / 8] = {};

    CHECK(!display::SeedPreviousIfSupported(display, region, body, sizeof(body)));
    CHECK(display.seed_count == 0);
    CHECK(!display::ReadPreviousIfSupported(display, {0, 0, 296, 24}, snapshot, sizeof(snapshot)));
    CHECK(display.read_count == 0);

    CHECK(display::PresentWithFallback(display, region, body, sizeof(body), display::PresentMode::kPartial));
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
    display::RequestRefreshWithFallback(display, display::PresentMode::kPartial);
    CHECK(display.refresh_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
}

void TestNoSeedDisplayCanPresentFullFrame() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.previous_frame_seed = false;
    FakeDisplay display{info};
    uint8_t     raw[4736] = {};

    CHECK(!display::SeedPreviousIfSupported(display, {0, 0, 296, 24}, raw, 296 * 24 / 8));
    CHECK(display.seed_count == 0);
    CHECK(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kFull));
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
}

void TestPresentFailureDoesNotCommitFrame() {
    FakeDisplay display{kFakeDisplayInfo};
    display.present_result = false;
    uint8_t raw[4736] = {};

    CHECK(!display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    CHECK(display.lock_count == 1);
    CHECK(display.unlock_count == 1);
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kPartial);
}

void TestFakeDisplayDrivesGenericFramePresentation() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    CHECK(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    CHECK(display.lock_count == 1);
    CHECK(display.unlock_count == 1);
    CHECK(display.present_count == 1);
    CHECK(display.last_region.x == 0);
    CHECK(display.last_region.y == 24);
    CHECK(display.last_region.width == 296);
    CHECK(display.last_region.height == 104);
    CHECK(display.last_len == 296 * 104 / 8);

    uint8_t too_short[4735] = {};
    CHECK(!display::PresentFrameBody(display, too_short, sizeof(too_short), 24, display::PresentMode::kPartial));
    CHECK(display.present_count == 1);
}

void TestRegionOffsetOverflowProtection() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    CHECK(!display::PresentFrameBody(display, raw, sizeof(raw), 128, display::PresentMode::kPartial));
    CHECK(display.present_count == 0);
    CHECK(display::ExpectedRegionOffsetBytes({0, 24, 296, 104}, kFakeFrame) == 888);
    CHECK(display::ExpectedRegionBytes({0, 24, 296, 104}, kFakeFrame) == 3848);
}

void TestFrameCandidateCommitKeepsCurrentOnFailure() {
    const int current   = 2;
    const int candidate = frame_scene::NextFrameCandidate(current, 4);
    CHECK(candidate == 3);
    CHECK(frame_scene::CommitFrameCandidate(current, candidate, false) == current);
    CHECK(frame_scene::CommitFrameCandidate(current, candidate, true) == candidate);
    CHECK(frame_scene::PrevFrameCandidate(0, 4) == 3);
}

void TestFrameLoadTransactionRollbackLeavesOldState() {
    FrameTransactionFake ops;
    ops.present_result = false;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(!frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.prepare_order > 0);
    CHECK(ops.caption_order > ops.lock_order);
    CHECK(ops.present_order > ops.caption_order);
    CHECK(ops.rollback_order > ops.present_order);
    CHECK(ops.unlock_order > ops.rollback_order);
    CHECK(ops.commit_order == 0);
    CHECK(ops.caption == "old");
    CHECK(ops.audio_state == 7);
    CHECK(ops.state_idx == 2);
}

void TestFrameLoadTransactionPrepareFailureIsSideEffectFree() {
    FrameTransactionFake ops;
    ops.prepare_result = false;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(!frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.prepare_order > 0);
    CHECK(ops.lock_order == 0);
    CHECK(ops.commit_order == 0);
    CHECK(ops.caption == "old");
    CHECK(ops.audio_state == 7);
    CHECK(ops.state_idx == 2);
}

void TestFrameLoadTransactionSuccessCommitsAfterUnlock() {
    FrameTransactionFake ops;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.rollback_order == 0);
    CHECK(ops.unlock_order > ops.present_order);
    CHECK(ops.commit_order > ops.unlock_order);
    CHECK(ops.committed_idx == 3);
    CHECK(ops.caption == "candidate");
    CHECK(ops.audio_state == 11);
    CHECK(ops.state_idx == 3);
}

void TestFrameLoadTransactionSeesAudioLoadedSetByPrepare() {
    bool audio_loaded = false;
    int  play_count   = 0;
    int  stop_count   = 0;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(frame_scene::RunFrameLoadTransaction(
        request,
        [&audio_loaded](int /*candidate_idx*/) {
            audio_loaded = true;
            return true;
        },
        []() { return true; },
        []() {},
        []() {},
        [](display::PresentMode /*mode*/) { return true; },
        []() {},
        []() {},
        [&audio_loaded, &play_count, &stop_count](int /*candidate_idx*/) {
            if (audio_loaded)
                ++play_count;
            else
                ++stop_count;
        }));
    CHECK(play_count == 1);
    CHECK(stop_count == 0);

    audio_loaded = false;
    play_count   = 0;
    stop_count   = 0;
    CHECK(!frame_scene::RunFrameLoadTransaction(
        request,
        [&audio_loaded](int /*candidate_idx*/) {
            audio_loaded = true;
            return true;
        },
        []() { return true; },
        []() {},
        []() {},
        [](display::PresentMode /*mode*/) { return false; },
        []() {},
        []() {},
        [&play_count, &stop_count](int /*candidate_idx*/) {
            ++play_count;
            ++stop_count;
        }));
    CHECK(play_count == 0);
    CHECK(stop_count == 0);
}

void TestBgRefreshWatcherCleanupBeforePostAndNoPersistence() {
    bool destroyed          = false;
    bool display_idle_event = false;
    bool done_event         = false;
    int  persistence_count  = 0;
    auto completion = std::make_shared<bg_refresh::CompletionState>(7);
    auto ctx = std::make_unique<CleanupProbe>(&destroyed);

    bg_refresh::RunWatcherCompletion(
        completion,
        []() { return true; },
        [&ctx]() { ctx.reset(); },
        [&](uint64_t generation) {
            CHECK(destroyed);
            CHECK(generation == 7);
            display_idle_event = true;
            return true;
        },
        [&](uint64_t generation) {
            CHECK(generation == 7);
            CHECK(destroyed);
            done_event = true;
            return true;
        },
        []() {});

    CHECK(destroyed);
    CHECK(display_idle_event);
    CHECK(!done_event);
    CHECK(persistence_count == 0);

    CHECK(bg_refresh::CompleteIdleOnUiTask(
        *completion,
        7,
        [&]() { ++persistence_count; },
        [&](uint64_t generation) {
            CHECK(generation == 7);
            done_event = true;
        }));
    CHECK(persistence_count == 1);
    CHECK(done_event);
}

void TestBgRefreshDeadlineWinnerPreventsWatcherCommit() {
    auto completion = std::make_shared<bg_refresh::CompletionState>(8);
    int  done_count         = 0;
    int  idle_event_count   = 0;

    bg_refresh::RunDeadlineCompletion(
        completion,
        []() { return false; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 8);
            ++done_count;
            return true;
        },
        []() {});

    bg_refresh::RunWatcherCompletion(
        completion,
        []() { return true; },
        []() {},
        [&](uint64_t /*generation*/) {
            ++idle_event_count;
            return true;
        },
        [&](uint64_t /*generation*/) {
            ++done_count;
            return true;
        },
        []() {});

    CHECK(done_count == 1);
    CHECK(idle_event_count == 0);
}

void TestBgRefreshWatcherWinnerUiCommitOnce() {
    auto completion = std::make_shared<bg_refresh::CompletionState>(9);
    int  done_count         = 0;
    int  idle_event_count   = 0;
    int  persistence_count  = 0;

    bg_refresh::RunWatcherCompletion(
        completion,
        []() { return true; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 9);
            ++idle_event_count;
            return true;
        },
        [&](uint64_t /*generation*/) {
            ++done_count;
            return true;
        },
        []() {});

    bg_refresh::RunDeadlineCompletion(
        completion,
        []() { return false; },
        []() {},
        [&](uint64_t /*generation*/) {
            ++done_count;
            return true;
        },
        []() {});

    CHECK(idle_event_count == 1);
    CHECK(done_count == 0);
    CHECK(bg_refresh::CompleteIdleOnUiTask(
        *completion,
        9,
        [&]() { ++persistence_count; },
        [&](uint64_t generation) {
            CHECK(generation == 9);
            ++done_count;
        }));
    CHECK(persistence_count == 1);
    CHECK(done_count == 1);
}

void TestBgRefreshIdlePostRetryAndDeadlineTakeover() {
    auto retry_completion = std::make_shared<bg_refresh::CompletionState>(10);
    int                         idle_post_attempts = 0;
    CHECK(bg_refresh::RunWatcherCompletion(
        retry_completion,
        []() { return true; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 10);
            ++idle_post_attempts;
            return idle_post_attempts == 2;
        },
        [](uint64_t /*generation*/) { return true; },
        []() {},
        2));
    CHECK(idle_post_attempts == 2);
    CHECK(retry_completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kIdleQueued);

    auto takeover_completion = std::make_shared<bg_refresh::CompletionState>(11);
    int                         failed_idle_posts = 0;
    CHECK(!bg_refresh::RunWatcherCompletion(
        takeover_completion,
        []() { return true; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 11);
            ++failed_idle_posts;
            return false;
        },
        [](uint64_t /*generation*/) { return true; },
        []() {},
        2));
    CHECK(failed_idle_posts == 2);
    CHECK(takeover_completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kWaiting);

    int done_posts = 0;
    CHECK(bg_refresh::RunDeadlineCompletion(
        takeover_completion,
        []() { return false; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 11);
            ++done_posts;
            return true;
        },
        []() {}));
    CHECK(done_posts == 1);
    CHECK(takeover_completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kDoneQueued);
}

void TestBgRefreshDeadlinePostRetryAndOldGenerationIgnored() {
    auto completion = std::make_shared<bg_refresh::CompletionState>(12);
    int                         done_attempts = 0;
    CHECK(bg_refresh::RunDeadlineCompletion(
        completion,
        []() { return false; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 12);
            ++done_attempts;
            return done_attempts == 2;
        },
        []() {},
        2));
    CHECK(done_attempts == 2);
    CHECK(completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kDoneQueued);

    auto idle_completion = std::make_shared<bg_refresh::CompletionState>(13);
    CHECK(bg_refresh::QueueIdleEvent(
        idle_completion,
        [](uint64_t /*generation*/) { return true; },
        1));
    int persistence_count = 0;
    int done_count        = 0;
    CHECK(!bg_refresh::CompleteIdleOnUiTask(
        *idle_completion,
        12,
        [&]() { ++persistence_count; },
        [&](uint64_t /*generation*/) {
            ++done_count;
        }));
    CHECK(persistence_count == 0);
    CHECK(done_count == 0);
}

void TestBgRefreshImmediateIdleConsumeDuringPost() {
    auto completion       = std::make_shared<bg_refresh::CompletionState>(14);
    int  persistence_count = 0;
    int  complete_count    = 0;
    CHECK(bg_refresh::RunWatcherCompletion(
        completion,
        []() { return true; },
        []() {},
        [&](uint64_t generation) {
            CHECK(bg_refresh::CompleteIdleOnUiTask(
                *completion,
                generation,
                [&]() { ++persistence_count; },
                [&](uint64_t completed_generation) {
                    CHECK(completed_generation == 14);
                    ++complete_count;
                }));
            return true;
        },
        [](uint64_t /*generation*/) { return true; },
        []() {},
        1));
    CHECK(persistence_count == 1);
    CHECK(complete_count == 1);
    CHECK(completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kCompleted);
}

void TestBgRefreshOwnerReleaseDuringPostDoesNotUseAfterFree() {
    bool destroyed = false;
    auto owner     = std::make_shared<bg_refresh::CompletionState>(15);
    auto ctx       = std::make_unique<CleanupProbe>(&destroyed);
    CHECK(bg_refresh::RunWatcherCompletion(
        owner,
        []() { return true; },
        [&]() { ctx.reset(); },
        [&](uint64_t generation) {
            CHECK(destroyed);
            CHECK(generation == 15);
            owner.reset();
            return true;
        },
        [](uint64_t /*generation*/) { return true; },
        []() {},
        1));
    CHECK(destroyed);
    CHECK(!owner);
}

void TestBgRefreshDeadlineWaitsForPublishingRollback() {
    auto completion = std::make_shared<bg_refresh::CompletionState>(16);
    completion->state.store(bg_refresh::CompletionStatus::kIdlePublishing, std::memory_order_release);
    int yields     = 0;
    int done_posts = 0;
    CHECK(bg_refresh::RunDeadlineCompletion(
        completion,
        []() { return false; },
        []() {},
        [&](uint64_t generation) {
            CHECK(generation == 16);
            ++done_posts;
            return true;
        },
        [&]() {
            ++yields;
            if (yields == 1) {
                bg_refresh::CompletionStatus expected = bg_refresh::CompletionStatus::kIdlePublishing;
                completion->state.compare_exchange_strong(expected, bg_refresh::CompletionStatus::kWaiting,
                                                          std::memory_order_acq_rel, std::memory_order_acquire);
            }
        },
        1,
        4));
    CHECK(yields == 1);
    CHECK(done_posts == 1);
    CHECK(completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kDoneQueued);
}

void TestBgRefreshDeadlineTaskRetryUntilPostSucceedsOrCancelled() {
    auto completion   = std::make_shared<bg_refresh::CompletionState>(17);
    int  post_attempt = 0;
    int  backoff      = 0;
    CHECK(bg_refresh::RunDeadlineRetryLoop(
        completion,
        [&]() { return bg_refresh::IsTerminal(completion->state.load(std::memory_order_acquire)); },
        [&](uint64_t generation) {
            CHECK(generation == 17);
            ++post_attempt;
            return post_attempt == 5;
        },
        [&]() { ++backoff; },
        2,
        4));
    CHECK(post_attempt == 5);
    CHECK(backoff >= 2);
    CHECK(completion->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kDoneQueued);

    auto cancelled = std::make_shared<bg_refresh::CompletionState>(18);
    int  cancel_backoff = 0;
    CHECK(!bg_refresh::RunDeadlineRetryLoop(
        cancelled,
        [&]() { return bg_refresh::IsTerminal(cancelled->state.load(std::memory_order_acquire)); },
        [&](uint64_t generation) {
            CHECK(generation == 18);
            return false;
        },
        [&]() {
            ++cancel_backoff;
            bg_refresh::Cancel(cancelled.get());
        },
        1,
        4));
    CHECK(cancel_backoff == 1);
    CHECK(cancelled->state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kCancelled);
}

void TestBgRefreshGenZeroWaitingOnlyClaim() {
    bg_refresh::CompletionState waiting{19};
    int                         complete_count = 0;
    CHECK(bg_refresh::CompleteWaitingOnUiTask(waiting, [&](uint64_t generation) {
        CHECK(generation == 19);
        ++complete_count;
    }));
    CHECK(complete_count == 1);
    CHECK(waiting.state.load(std::memory_order_acquire) == bg_refresh::CompletionStatus::kCompleted);
    CHECK(!bg_refresh::CompleteWaitingOnUiTask(waiting, [&](uint64_t /*generation*/) { ++complete_count; }));
    CHECK(complete_count == 1);

    bg_refresh::CompletionState claimed{20};
    claimed.state.store(bg_refresh::CompletionStatus::kDoneQueued, std::memory_order_release);
    CHECK(!bg_refresh::CompleteWaitingOnUiTask(claimed, [&](uint64_t /*generation*/) { ++complete_count; }));
}

void TestBgRefreshGenerationDoesNotReuseAcrossSceneInstances() {
    uint64_t counter = 0;
    auto first = std::make_shared<bg_refresh::CompletionState>(bg_refresh::NextGeneration(counter));
    bg_refresh::Cancel(first.get());
    first.reset();
    auto second = std::make_shared<bg_refresh::CompletionState>(bg_refresh::NextGeneration(counter));
    CHECK(second->generation == 2);

    counter = std::numeric_limits<uint64_t>::max();
    CHECK(bg_refresh::NextGeneration(counter) == 1);
}

void TestStatusBarSnapshotIdentityRejectsSameSizeLayoutChange() {
    const auto stored =
        power_state::MakeStatusBarSnapshotIdentity(kFakeDisplayInfo, {0, 0, 296, 24}, 296 * 24 / 8);

    CHECK(power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 0, 296, 24}, 296 * 24 / 8));
    CHECK(!power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 8, 296, 24}, 296 * 24 / 8));
    CHECK(!power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 0, 296, 16}, 296 * 16 / 8));
}

}  // namespace

int main() {
    TestNote4PlatformInfo();
    TestIndependentFakePlatformInfo();
    TestDescriptorByteSizeValidation();
    TestCapabilityDegradeHelpers();
    TestNoSeedDisplayCanPresentFullFrame();
    TestPresentFailureDoesNotCommitFrame();
    TestFakeDisplayDrivesGenericFramePresentation();
    TestRegionOffsetOverflowProtection();
    TestFrameCandidateCommitKeepsCurrentOnFailure();
    TestFrameLoadTransactionRollbackLeavesOldState();
    TestFrameLoadTransactionPrepareFailureIsSideEffectFree();
    TestFrameLoadTransactionSuccessCommitsAfterUnlock();
    TestFrameLoadTransactionSeesAudioLoadedSetByPrepare();
    TestBgRefreshWatcherCleanupBeforePostAndNoPersistence();
    TestBgRefreshDeadlineWinnerPreventsWatcherCommit();
    TestBgRefreshWatcherWinnerUiCommitOnce();
    TestBgRefreshIdlePostRetryAndDeadlineTakeover();
    TestBgRefreshDeadlinePostRetryAndOldGenerationIgnored();
    TestBgRefreshImmediateIdleConsumeDuringPost();
    TestBgRefreshOwnerReleaseDuringPostDoesNotUseAfterFree();
    TestBgRefreshDeadlineWaitsForPublishingRollback();
    TestBgRefreshDeadlineTaskRetryUntilPostSucceedsOrCancelled();
    TestBgRefreshGenZeroWaitingOnlyClaim();
    TestBgRefreshGenerationDoesNotReuseAcrossSceneInstances();
    TestStatusBarSnapshotIdentityRejectsSameSizeLayoutChange();
    return g_failures == 0 ? 0 : 1;
}
