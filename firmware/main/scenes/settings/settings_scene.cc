#include "scenes/settings/settings_scene.h"

#include <esp_log.h>
#include <memory>
#include <utility>

#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "scenes/core/scene_stack.h"
#include "scenes/settings/settings_pages.h"
#include "ui/menu_list.h"
#include "ui/theme.h"

namespace {
constexpr char kTag[] = "settings";
}

SettingsScene::SettingsScene()  = default;
SettingsScene::~SettingsScene() = default;

void SettingsScene::OnEnter(SceneContext& ctx) {
    ESP_LOGD(kTag, "enter saved_cursor=%d", saved_cursor_);
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "enter failed reason=epd_lock_timeout");
        return;
    }

    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("设置");

    // 三段语义分组(MenuList 不显式画分隔,靠顺序传达):
    //   偏好    音量调节
    //   信息    设备信息
    //   危险    重启设备 / 恢复出厂(永远末尾,避免误触)
    auto*                       stack = ctx.stack;
    std::vector<MenuList::Item> items = {
        {"音量调节", [stack]() { stack->RequestPush(std::make_unique<VolumePage>()); }},
        {"设备信息", [stack]() { stack->RequestPush(std::make_unique<DeviceInfoPage>()); }},
        {"重启设备", [stack]() { stack->RequestPush(std::make_unique<RestartDevicePage>()); }},
        {"恢复出厂", [stack]() { stack->RequestPush(std::make_unique<FactoryResetPage>()); }},
    };
    menu_ = std::make_unique<MenuList>(root_, std::move(items), saved_cursor_);

    RefreshStatusBarFromSensors(ctx, *status_bar_);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // 子页 OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 自己看 diff>=30% 兜底升 full。
    // 从 frame 进来 diff 必然 >30% 自动 full;settings ↔ 子页之间 partial 即可。
    display::RequestRefreshWithFallback(*ctx.epd, display::PresentMode::kPartial);
    ESP_LOGD(kTag, "enter done root=%p", root_);
}

void SettingsScene::OnExit(SceneContext& ctx) {
    ESP_LOGD(kTag, "exit root=%p cursor=%d", root_, menu_ ? menu_->Cursor() : -1);
    DestroyRoot(ctx, root_, [this]() {
        // push 子页时 OnExit 触发,记录光标位置 — 子页 pop 回来 OnEnter 恢复。
        if (menu_)
            saved_cursor_ = menu_->Cursor();
        menu_.reset();
        status_bar_.reset();
    });
}

void SettingsScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (evt::log::DebugEnabled(kTag)) {
        char detail[128];
        evt::log::Describe(e, detail, sizeof(detail));
        ESP_LOGD(kTag, "event kind=%s detail=%s root=%p menu=%p cursor=%d", evt::log::KindName(e.kind), detail, root_,
                 menu_.get(), menu_ ? menu_->Cursor() : -1);
    }
    if (!root_ || !menu_) {
        ESP_LOGW(kTag, "event ignored reason=no_root root=%p menu=%p kind=%s", root_, menu_.get(),
                 evt::log::KindName(e.kind));
        return;
    }
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    SyncRender(
                        ctx,
                        [this]() {
                            const int before = menu_->Cursor();
                            menu_->OnUp();
                            ESP_LOGD(kTag, "button short btn=up action=menu_up from=%d to=%d", before, menu_->Cursor());
                        },
                        false);
                    break;
                case ButtonId::kDown:
                    SyncRender(
                        ctx,
                        [this]() {
                            const int before = menu_->Cursor();
                            menu_->OnDown();
                            ESP_LOGD(kTag, "button short btn=down action=menu_down from=%d to=%d", before,
                                     menu_->Cursor());
                        },
                        false);
                    break;
                case ButtonId::kEnter:
                    ESP_LOGD(kTag, "button short btn=enter action=menu_enter cursor=%d", menu_->Cursor());
                    menu_->OnEnter();
                    break;  // RequestPush 由 callback 走,ApplyPending 处理
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGD(kTag, "button long btn=enter action=pop");
                ctx.stack->RequestPop();
            }
            break;
        }
        default:
            break;
    }
}
