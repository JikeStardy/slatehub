#include "scenes/xiaozhi/xiaozhi_scene.h"

#include <esp_log.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>

#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "scenes/core/scene_stack.h"
#include "scenes/settings/settings_scene.h"
#include "ui/theme.h"
#include "utils/utf8_utils.h"
#include "xiaozhi/service/xiaozhi_service.h"

namespace {
constexpr char kTag[]                    = "xiaozhi";
constexpr int  kStandbyBottomHintReserve = 46;

int RootCenterYOffset(int y) {
    return y - (LV_VER_RES / 2);
}

int StandbyContentCenterY() {
    return theme::kStatusBarHeight + (LV_VER_RES - theme::kStatusBarHeight - kStandbyBottomHintReserve) / 2;
}

std::string DisplayText(const std::string& text) {
    return util::TrimForScreen(util::SanitizeForScreen(text), 120);
}

std::string MessagesKey(const xiaozhi::XiaozhiSnapshot& snap) {
    std::string key;
    for (const auto& msg : snap.messages) {
        key += msg.role;
        key.push_back('\x1F');
        key += util::SanitizeForScreen(msg.text);
        key.push_back('\x1E');
    }
    return key;
}

const char* EmotionIcon(const std::string& emotion, xiaozhi::XiaozhiState state) {
    if (state == xiaozhi::XiaozhiState::kCheckingConfig || state == xiaozhi::XiaozhiState::kConnecting ||
        state == xiaozhi::XiaozhiState::kStopping)
        return FONT_AWESOME_THINKING;
    if (state == xiaozhi::XiaozhiState::kError)
        return FONT_AWESOME_SAD;

    if (emotion == "happy")
        return FONT_AWESOME_HAPPY;
    if (emotion == "laughing")
        return FONT_AWESOME_LAUGHING;
    if (emotion == "funny")
        return FONT_AWESOME_FUNNY;
    if (emotion == "sad")
        return FONT_AWESOME_SAD;
    if (emotion == "angry")
        return FONT_AWESOME_ANGRY;
    if (emotion == "crying")
        return FONT_AWESOME_CRYING;
    if (emotion == "loving")
        return FONT_AWESOME_LOVING;
    if (emotion == "embarrassed")
        return FONT_AWESOME_EMBARRASSED;
    if (emotion == "surprised")
        return FONT_AWESOME_SURPRISED;
    if (emotion == "shocked")
        return FONT_AWESOME_SHOCKED;
    if (emotion == "thinking")
        return FONT_AWESOME_THINKING;
    if (emotion == "winking")
        return FONT_AWESOME_WINKING;
    if (emotion == "cool")
        return FONT_AWESOME_COOL;
    if (emotion == "relaxed")
        return FONT_AWESOME_RELAXED;
    if (emotion == "delicious")
        return FONT_AWESOME_DELICIOUS;
    if (emotion == "kissy")
        return FONT_AWESOME_KISSY;
    if (emotion == "confident")
        return FONT_AWESOME_CONFIDENT;
    if (emotion == "sleepy")
        return FONT_AWESOME_SLEEPY;
    if (emotion == "silly")
        return FONT_AWESOME_SILLY;
    if (emotion == "confused")
        return FONT_AWESOME_CONFUSED;
    return FONT_AWESOME_NEUTRAL;
}

std::string StatusTitle(const xiaozhi::XiaozhiSnapshot& snap) {
    switch (snap.state) {
        case xiaozhi::XiaozhiState::kReadyIdle:
            return snap.alert_active && !snap.status.empty() ? snap.status : "小智AI";
        case xiaozhi::XiaozhiState::kListening:
            return snap.status.empty() ? "聆听中" : snap.status;
        case xiaozhi::XiaozhiState::kSpeaking:
            return snap.status.empty() ? "回复中" : snap.status;
        case xiaozhi::XiaozhiState::kConnecting:
        case xiaozhi::XiaozhiState::kStopping:
        case xiaozhi::XiaozhiState::kCheckingConfig:
        case xiaozhi::XiaozhiState::kAwaitingActivation:
        case xiaozhi::XiaozhiState::kError:
            return snap.status.empty() ? "小智AI" : snap.status;
    }
    return "小智AI";
}

void StyleTransparent(lv_obj_t* obj) {
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
}

void StyleBubble(lv_obj_t* bubble) {
    lv_obj_set_style_bg_opa(bubble, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(bubble, 1, 0);
    lv_obj_set_style_border_color(bubble, lv_color_black(), 0);
    lv_obj_set_style_radius(bubble, 8, 0);
    lv_obj_set_style_pad_left(bubble, 8, 0);
    lv_obj_set_style_pad_right(bubble, 8, 0);
    lv_obj_set_style_pad_top(bubble, 6, 0);
    lv_obj_set_style_pad_bottom(bubble, 6, 0);
    lv_obj_clear_flag(bubble, LV_OBJ_FLAG_SCROLLABLE);
}
}  // namespace

xiaozhi::XiaozhiService* XiaozhiScene::Service(SceneContext& ctx) {
    if (!service_ && ctx.xiaozhi_service)
        service_ = ctx.xiaozhi_service();
    return service_;
}

void XiaozhiScene::EnsureServiceStarted(SceneContext& ctx) {
    if (service_entered_)
        return;
    auto* service = Service(ctx);
    if (!service || !service->IsStarted()) {
        if (!root_ || !status_bar_ || !hint_label_)
            return;
        status_bar_->SetCaption("小智异常");
        status_bar_->SetCaptionIcon(FONT_AWESOME_SAD);
        HideContentViews();
        RenderSystemMessage("小智音频初始化失败\n\n请稍后重试或重启设备", false, "");
        lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(hint_label_, "双击确认 返回");
        return;
    }
    service->EnterMode();
    service_entered_ = true;
}

void XiaozhiScene::OnEnter(SceneContext& ctx) {
    ESP_LOGD(kTag, "enter service_entered=%d", service_entered_ ? 1 : 0);
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "enter failed reason=epd_lock_timeout");
        EnsureServiceStarted(ctx);
        return;
    }

    CreateLayout();
    RefreshStatusBarFromSensors(ctx, *status_bar_);
    EnsureServiceStarted(ctx);
    if (service_entered_) {
        RenderContent();
    }

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    display::RequestRefreshWithFallback(*ctx.epd, display::PresentMode::kFull);
    ESP_LOGD(kTag, "enter done root=%p service_entered=%d", root_, service_entered_ ? 1 : 0);
}

void XiaozhiScene::OnExit(SceneContext& ctx) {
    ESP_LOGD(kTag, "exit root=%p service_entered=%d", root_, service_entered_ ? 1 : 0);
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        standby_icon_label_     = nullptr;
        standby_body_label_     = nullptr;
        system_label_           = nullptr;
        code_label_             = nullptr;
        xiaozhi_area_           = nullptr;
        xiaozhi_content_        = nullptr;
        xiaozhi_empty_label_    = nullptr;
        hint_label_             = nullptr;
        rendered_message_count_ = 0;
        rendered_messages_key_.clear();
    });
    if (service_entered_) {
        if (auto* service = Service(ctx))
            service->LeaveMode();
        service_entered_ = false;
    }
}

void XiaozhiScene::CreateLayout() {
    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("小智AI");

    code_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(code_label_, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(code_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(code_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_letter_space(code_label_, 4, 0);
    lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);

    standby_icon_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_icon_label_, &font_awesome_30_1, 0);
    lv_obj_set_style_text_color(standby_icon_label_, lv_color_black(), 0);
    lv_label_set_text(standby_icon_label_, FONT_AWESOME_MICROCHIP_AI);
    lv_obj_align(standby_icon_label_, LV_ALIGN_CENTER, 0, RootCenterYOffset(StandbyContentCenterY() - 26));

    standby_body_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_body_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(standby_body_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(standby_body_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(standby_body_label_, "按确认开始聊天");
    lv_obj_set_width(standby_body_label_, LV_HOR_RES - 48);
    lv_obj_align(standby_body_label_, LV_ALIGN_CENTER, 0, RootCenterYOffset(StandbyContentCenterY() + 26));

    system_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(system_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(system_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(system_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(system_label_, 6, 0);
    lv_label_set_long_mode(system_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(system_label_, LV_HOR_RES - 40);

    xiaozhi_area_ = lv_obj_create(root_);
    lv_obj_set_size(xiaozhi_area_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(xiaozhi_area_, 0, theme::kStatusBarHeight);
    StyleTransparent(xiaozhi_area_);

    xiaozhi_content_ = lv_obj_create(xiaozhi_area_);
    lv_obj_set_size(xiaozhi_content_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(xiaozhi_content_, 0, 0);
    lv_obj_set_style_bg_opa(xiaozhi_content_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(xiaozhi_content_, 0, 0);
    lv_obj_set_style_pad_left(xiaozhi_content_, 0, 0);
    lv_obj_set_style_pad_right(xiaozhi_content_, 0, 0);
    lv_obj_set_style_pad_top(xiaozhi_content_, 14, 0);
    lv_obj_set_style_pad_bottom(xiaozhi_content_, 14, 0);
    lv_obj_set_style_pad_row(xiaozhi_content_, 8, 0);
    lv_obj_set_scroll_dir(xiaozhi_content_, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(xiaozhi_content_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_flex_flow(xiaozhi_content_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(xiaozhi_content_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    xiaozhi_empty_label_ = lv_label_create(xiaozhi_area_);
    lv_obj_set_style_text_font(xiaozhi_empty_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(xiaozhi_empty_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(xiaozhi_empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(xiaozhi_empty_label_, "正在听，想聊点什么？");
    lv_obj_set_width(xiaozhi_empty_label_, LV_HOR_RES - 48);
    lv_obj_align(xiaozhi_empty_label_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(xiaozhi_empty_label_, LV_OBJ_FLAG_HIDDEN);

    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(hint_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint_label_, LV_HOR_RES - 16);
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -10);
}

void XiaozhiScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (evt::log::DebugEnabled(kTag)) {
        char detail[128];
        evt::log::Describe(e, detail, sizeof(detail));
        ESP_LOGD(kTag, "event kind=%s detail=%s root=%p", evt::log::KindName(e.kind), detail, root_);
    }
    if (!root_) {
        ESP_LOGW(kTag, "event ignored reason=no_root kind=%s", evt::log::KindName(e.kind));
        return;
    }
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kEnter:
                    ESP_LOGD(kTag, "button short btn=enter action=toggle_chat");
                    if (auto* service = Service(ctx))
                        service->ToggleXiaozhi();
                    break;
                case ButtonId::kUp:
                    ESP_LOGD(kTag, "button short btn=up action=volume_up");
                    if (auto* service = Service(ctx))
                        service->AdjustVolume(+1);
                    break;
                case ButtonId::kDown:
                    ESP_LOGD(kTag, "button short btn=down action=volume_down");
                    if (auto* service = Service(ctx))
                        service->AdjustVolume(-1);
                    break;
            }
            break;
        case UiEventKind::kButtonDouble:
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGD(kTag, "button double btn=enter action=pop");
                if (auto* service = Service(ctx))
                    service->LeaveMode();
                ctx.stack->RequestPop();
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGD(kTag, "button long btn=enter action=settings");
                if (auto* service = Service(ctx))
                    service->StopConversation(true);
                ctx.stack->RequestPush(std::make_unique<SettingsScene>());
            }
            break;
        case UiEventKind::kXiaozhiChanged:
            Render(ctx);
            break;
        case UiEventKind::kChargeChanged:
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kWifiStateChanged:
        case UiEventKind::kMinuteTick:
            if (root_) {
                SyncRender(ctx, [this, &ctx]() {
                    if (status_bar_)
                        RefreshStatusBarFromSensors(ctx, *status_bar_);
                    RenderContent();
                });
            }
            break;
        default:
            break;
    }
}

void XiaozhiScene::Render(SceneContext& ctx, bool full) {
    if (!root_)
        return;
    SyncRender(ctx, [this]() { RenderContent(); }, full);
}

void XiaozhiScene::RenderContent() {
    if (!root_ || !status_bar_ || !system_label_ || !code_label_ || !hint_label_)
        return;
    if (!service_)
        return;

    const auto snap = service_->Snapshot();
    UpdateStatusBarTitle(snap);
    HideContentViews();

    if (snap.alert_active) {
        const std::string title   = DisplayText(snap.alert_status.empty() ? "小智提醒" : snap.alert_status);
        const std::string message = util::TrimForScreen(util::SanitizeForScreen(snap.alert_message), 72);
        RenderSystemMessage(title + (message.empty() ? "" : "\n\n" + message), false, "");
    } else {
        switch (snap.state) {
            case xiaozhi::XiaozhiState::kCheckingConfig:
                RenderSystemMessage("正在获取小智配置...", false, "");
                break;
            case xiaozhi::XiaozhiState::kAwaitingActivation:
                RenderSystemMessage(
                    snap.activation_message.empty() ? "请在小智控制台输入激活码" : DisplayText(snap.activation_message),
                    true, snap.activation_code);
                break;
            case xiaozhi::XiaozhiState::kReadyIdle:
                lv_obj_clear_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
                lv_obj_clear_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
                break;
            case xiaozhi::XiaozhiState::kConnecting:
                RenderSystemMessage("正在连接小智服务器...", false, "");
                break;
            case xiaozhi::XiaozhiState::kStopping:
                RenderSystemMessage("正在结束当前对话...", false, "");
                break;
            case xiaozhi::XiaozhiState::kListening:
            case xiaozhi::XiaozhiState::kSpeaking:
                RenderXiaozhiMessages(snap);
                break;
            case xiaozhi::XiaozhiState::kError:
                RenderSystemMessage("小智暂不可用\n\n" + util::TrimForScreen(util::SanitizeForScreen(snap.error), 72),
                                    false, "");
                break;
        }
    }
    if (snap.state == xiaozhi::XiaozhiState::kListening || snap.state == xiaozhi::XiaozhiState::kSpeaking) {
        lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(hint_label_, "上/下 调音量   长按确认 设置   双击确认 返回");
    }
}

void XiaozhiScene::HideContentViews() {
    lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(xiaozhi_area_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(xiaozhi_empty_label_, LV_OBJ_FLAG_HIDDEN);
}

void XiaozhiScene::RenderSystemMessage(const std::string& text, bool show_code, const std::string& code) {
    lv_label_set_text(system_label_, text.c_str());
    lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
    if (show_code) {
        lv_label_set_text(code_label_, code.c_str());
        lv_obj_clear_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, -44);
        lv_obj_align(code_label_, LV_ALIGN_CENTER, 0, 18);
    } else {
        lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
    }
}

void XiaozhiScene::RenderXiaozhiMessages(const xiaozhi::XiaozhiSnapshot& snap) {
    lv_obj_clear_flag(xiaozhi_area_, LV_OBJ_FLAG_HIDDEN);
    const bool        state_changed = rendered_state_ != static_cast<int>(snap.state);
    const std::string messages_key  = MessagesKey(snap);
    const bool        should_rebuild =
        state_changed || rendered_message_count_ != snap.messages.size() || rendered_messages_key_ != messages_key;
    if (state_changed && snap.state == xiaozhi::XiaozhiState::kListening && snap.messages.empty())
        ClearXiaozhiMessages();

    if (should_rebuild) {
        ClearXiaozhiMessages();
        for (const auto& msg : snap.messages)
            AppendXiaozhiBubble(msg.role, msg.text);
        rendered_message_count_ = snap.messages.size();
        rendered_messages_key_  = messages_key;
    }

    if (xiaozhi_content_ && lv_obj_get_child_cnt(xiaozhi_content_) == 0)
        ShowEmptyXiaozhiHint();

    rendered_state_ = static_cast<int>(snap.state);
}

void XiaozhiScene::ClearXiaozhiMessages() {
    if (!xiaozhi_content_)
        return;
    lv_obj_clean(xiaozhi_content_);
    rendered_message_count_ = 0;
    rendered_messages_key_.clear();
}

void XiaozhiScene::ShowEmptyXiaozhiHint() {
    if (xiaozhi_empty_label_) {
        lv_obj_clear_flag(xiaozhi_empty_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(xiaozhi_empty_label_, LV_ALIGN_CENTER, 0, 0);
    }
}

void XiaozhiScene::AppendXiaozhiBubble(const std::string& role, const std::string& text) {
    if (text.empty()) {
        return;
    }

    const std::string display_text = DisplayText(text);
    if (display_text.empty())
        return;

    const bool user   = role == "user";
    const bool system = role == "system";
    lv_obj_t*  row    = lv_obj_create(xiaozhi_content_);
    lv_obj_set_width(row, LV_HOR_RES);
    lv_obj_set_height(row, LV_SIZE_CONTENT);
    lv_obj_set_style_flex_grow(row, 0, 0);
    StyleTransparent(row);

    lv_obj_t* bubble = lv_obj_create(row);
    StyleBubble(bubble);
    lv_obj_t* label = lv_label_create(bubble);
    lv_obj_set_style_text_font(label, &Zfull_16, 0);
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(label, 4, 0);
    LayoutBubble(bubble, label, display_text);
    lv_obj_set_height(row, lv_obj_get_height(bubble) + 2);

    if (system)
        lv_obj_align(bubble, LV_ALIGN_CENTER, 0, 0);
    else if (user)
        lv_obj_align(bubble, LV_ALIGN_RIGHT_MID, -18, 0);
    else
        lv_obj_align(bubble, LV_ALIGN_LEFT_MID, 18, 0);

    lv_obj_scroll_to_view_recursive(row, LV_ANIM_OFF);
}

void XiaozhiScene::LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text) {
    lv_label_set_text(label, text.c_str());
    lv_obj_set_width(label, LV_SIZE_CONTENT);
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
    lv_obj_update_layout(label);

    constexpr int kMaxTextW = 308;
    constexpr int kMinTextW = 36;
    const int     measured  = lv_obj_get_width(label);
    const int     text_w    = std::clamp(measured, kMinTextW, kMaxTextW);
    if (measured > kMaxTextW) {
        lv_obj_set_width(label, kMaxTextW);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    } else {
        lv_obj_set_width(label, text_w);
    }

    lv_obj_set_width(bubble, text_w + 18);
    lv_obj_set_height(bubble, LV_SIZE_CONTENT);
    lv_obj_update_layout(bubble);
}

void XiaozhiScene::UpdateStatusBarTitle(const xiaozhi::XiaozhiSnapshot& snap) {
    status_bar_->SetCaption(StatusTitle(snap));
    if (snap.state == xiaozhi::XiaozhiState::kReadyIdle && !snap.alert_active) {
        status_bar_->SetCaptionIcon(nullptr);
    } else {
        status_bar_->SetCaptionIcon(EmotionIcon(snap.emotion, snap.state));
    }
}
