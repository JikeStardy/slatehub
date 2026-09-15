#include "scenes/settings/settings_pages.h"

#include <esp_heap_caps.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <sdkconfig.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

#include "drivers/audio/audio_player.h"
#include "events/event_bus.h"
#include "network/cred_store.h"
#include "network/wifi.h"
#include "power/shutdown.h"
#include "scenes/core/scene_stack.h"
#include "storage/cache/cache.h"
#include "storage/nvs/nvs_schema.h"
#include "storage/nvs/nvs_store.h"
#include "storage/nvs/volume_store.h"
#include "ui/scrollbar.h"
#include "ui/theme.h"
#include "utils/mac_utils.h"
#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/xiaozhi_service.h"

namespace {
constexpr char kDeviceInfoTag[]   = "device_info";
constexpr char kRestartTag[]      = "restart";
constexpr char kFactoryResetTag[] = "factory_reset";
constexpr int  kBarWidth          = 280;
constexpr int  kBarHeight         = 24;

const char* ChargeText(const ChargeStatus::Snapshot& s) {
    if (s.no_battery)
        return "无电池";
    if (s.full)
        return "已充满";
    if (s.charging)
        return "充电中";
    if (s.power_present)
        return "已接电源";
    return "电池供电";
}

std::vector<uint8_t> MakeTestTone() {
    constexpr int        kRate    = 16000;
    constexpr int        kMs      = 200;
    constexpr float      kFreq    = 440.0f;
    constexpr int        kSamples = kRate * kMs / 1000;
    std::vector<uint8_t> buf(kSamples * 2);
    for (int i = 0; i < kSamples; ++i) {
        const float t  = static_cast<float>(i) / kRate;
        int16_t     s  = static_cast<int16_t>(0.6f * 32767.0f * std::sin(2.0f * 3.1415926f * kFreq * t));
        buf[2 * i + 0] = static_cast<uint8_t>(s & 0xFF);
        buf[2 * i + 1] = static_cast<uint8_t>((s >> 8) & 0xFF);
    }
    return buf;
}
}  // namespace

ConfirmActionPage::ConfirmActionPage(std::string name, std::string caption, std::string warning)
    : name_(std::move(name)), caption_(std::move(caption)), warning_(std::move(warning)) {
}

ConfirmActionPage::~ConfirmActionPage() = default;

void ConfirmActionPage::OnEnter(SceneContext& ctx) {
    if (!EnterSettingsScaffold(ctx, caption_.c_str()))
        return;

    auto* warn = lv_label_create(RootObj());
    lv_obj_set_style_text_font(warn, &Zfull_16, 0);
    lv_obj_set_style_text_color(warn, lv_color_black(), 0);
    lv_obj_set_style_text_align(warn, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(warn, 8, 0);
    lv_obj_set_width(warn, LV_HOR_RES - 64);
    lv_label_set_long_mode(warn, LV_LABEL_LONG_WRAP);
    lv_label_set_text(warn, warning_.c_str());
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, -8);

    CreateBottomHint("按确认 返回   长按确认 执行");
    FinishSettingsScaffoldEnter(ctx);
}

void ConfirmActionPage::OnExit(SceneContext& ctx) {
    ExitSettingsScaffold(ctx);
}

void ConfirmActionPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!RootObj())
        return;
    if (e.kind == UiEventKind::kButtonShort && e.u.button.btn == ButtonId::kEnter) {
        ctx.stack->RequestPop();
        return;
    }
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        Confirm(ctx);
    }
}

VolumePage::VolumePage() = default;

VolumePage::~VolumePage() = default;

void VolumePage::OnEnter(SceneContext& ctx) {
    if (!EnterSettingsScaffold(ctx, "音量调节"))
        return;

    value_label_ = lv_label_create(RootObj());
    lv_obj_set_style_text_font(value_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(value_label_, lv_color_black(), 0);
    lv_obj_align(value_label_, LV_ALIGN_CENTER, 0, -32);

    bar_track_ = lv_obj_create(RootObj());
    lv_obj_set_size(bar_track_, kBarWidth, kBarHeight);
    lv_obj_align(bar_track_, LV_ALIGN_CENTER, 0, 4);
    lv_obj_set_style_bg_color(bar_track_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(bar_track_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(bar_track_, lv_color_black(), 0);
    lv_obj_set_style_border_width(bar_track_, 1, 0);
    lv_obj_set_style_radius(bar_track_, 0, 0);
    lv_obj_set_style_pad_all(bar_track_, 0, 0);
    lv_obj_clear_flag(bar_track_, LV_OBJ_FLAG_SCROLLABLE);

    bar_fill_ = lv_obj_create(bar_track_);
    lv_obj_set_size(bar_fill_, 0, kBarHeight - 2);
    lv_obj_set_pos(bar_fill_, 0, 0);
    lv_obj_set_style_bg_color(bar_fill_, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(bar_fill_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(bar_fill_, 0, 0);
    lv_obj_set_style_radius(bar_fill_, 0, 0);
    lv_obj_set_style_pad_all(bar_fill_, 0, 0);
    lv_obj_clear_flag(bar_fill_, LV_OBJ_FLAG_SCROLLABLE);

    hint_label_ = CreateBottomHint("上/下 调节   按确认 返回   长按确认 试听");

    level_ = vol::Get();
    RedrawValue();

    FinishSettingsScaffoldEnter(ctx);
}

void VolumePage::OnExit(SceneContext& ctx) {
    if (dirty_) {
        SaveLevel(ctx);
        dirty_ = false;
    }
    ExitSettingsScaffold(ctx, [this]() {
        bar_track_   = nullptr;
        bar_fill_    = nullptr;
        value_label_ = nullptr;
        hint_label_  = nullptr;
    });
}

void VolumePage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!RootObj())
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    if (level_ < vol::kMax) {
                        level_++;
                        dirty_ = true;
                        ApplyLevel(ctx);
                        SyncRender(ctx, [this]() { RedrawValue(); });
                    }
                    break;
                case ButtonId::kDown:
                    if (level_ > 0) {
                        level_--;
                        dirty_ = true;
                        ApplyLevel(ctx);
                        SyncRender(ctx, [this]() { RedrawValue(); });
                    }
                    break;
                case ButtonId::kEnter:
                    ctx.stack->RequestPop();
                    break;
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter)
                PlayTestTone(ctx);
            break;
        default:
            break;
    }
}

void VolumePage::RedrawValue() {
    if (value_label_) {
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%d / %d", level_, vol::kMax);
        lv_label_set_text(value_label_, buf);
        lv_obj_align(value_label_, LV_ALIGN_CENTER, 0, -32);
    }
    if (bar_fill_) {
        const int inner = kBarWidth - 2;
        const int w     = (inner * level_) / vol::kMax;
        lv_obj_set_size(bar_fill_, w, kBarHeight - 2);
    }
}

void VolumePage::ApplyLevel(SceneContext& ctx) {
    if (ctx.xiaozhi_service) {
        if (auto* service = ctx.xiaozhi_service()) {
            service->PreviewVolume(level_);
            return;
        }
    }
    AudioPlayer::Get().SetVolume(vol::ToCodec(level_));
}

void VolumePage::SaveLevel(SceneContext& ctx) {
    if (ctx.xiaozhi_service) {
        if (auto* service = ctx.xiaozhi_service()) {
            service->SetVolume(level_);
            return;
        }
    }
    vol::Set(level_);
    AudioPlayer::Get().SetVolume(vol::ToCodec(level_));
}

void VolumePage::PlayTestTone(SceneContext& ctx) {
    if (!ctx.audio)
        return;
    if (test_tone_.empty())
        test_tone_ = MakeTestTone();
    ctx.audio->Play(test_tone_.data(), test_tone_.size());
}

DeviceInfoPage::DeviceInfoPage()  = default;
DeviceInfoPage::~DeviceInfoPage() = default;

void DeviceInfoPage::OnEnter(SceneContext& ctx) {
    LoadStaticInfo();

    if (!ctx.epd->Lock(2000))
        return;

    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("设备信息");

    scroll_area_ = lv_obj_create(root_);
    lv_obj_set_size(scroll_area_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(scroll_area_, 0, theme::kStatusBarHeight);
    lv_obj_set_style_bg_color(scroll_area_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(scroll_area_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scroll_area_, 0, 0);
    lv_obj_set_style_pad_bottom(scroll_area_, 16, 0);
    lv_obj_set_style_border_width(scroll_area_, 0, 0);
    lv_obj_add_flag(scroll_area_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(scroll_area_, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(scroll_area_, LV_SCROLLBAR_MODE_OFF);

    info_ = lv_label_create(scroll_area_);
    lv_obj_set_style_text_font(info_, &Zfull_16, 0);
    lv_obj_set_style_text_color(info_, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(info_, 4, 0);
    lv_obj_set_style_text_align(info_, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_width(info_, LV_HOR_RES - 48);
    lv_label_set_long_mode(info_, LV_LABEL_LONG_WRAP);
    lv_obj_set_pos(info_, 24, 12);

    thumb_ = lv_obj_create(root_);
    ui::StyleScrollbarThumb(thumb_);

    (void)Refresh(ctx);
    UpdateThumb();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}

void DeviceInfoPage::OnExit(SceneContext& ctx) {
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        scroll_area_ = nullptr;
        info_        = nullptr;
        thumb_       = nullptr;
    });
}

void DeviceInfoPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_)
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    ScrollBy(ctx, -theme::kDeviceInfoScrollStep);
                    break;
                case ButtonId::kDown:
                    ScrollBy(ctx, +theme::kDeviceInfoScrollStep);
                    break;
                case ButtonId::kEnter:
                    ctx.stack->RequestPop();
                    break;
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter)
                ctx.stack->RequestPop();
            break;
        case UiEventKind::kChargeChanged:
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kWifiStateChanged:
        case UiEventKind::kMinuteTick:
            SyncRenderIfChanged(
                ctx,
                [this, &ctx]() {
                    const bool changed = Refresh(ctx);
                    if (changed)
                        UpdateThumb();
                    return changed;
                },
                false);
            break;
        default:
            break;
    }
}

void DeviceInfoPage::ScrollBy(SceneContext& ctx, int dy_view) {
    if (!scroll_area_)
        return;
    const int cur_y = lv_obj_get_scroll_y(scroll_area_);
    const int max_y = cur_y + lv_obj_get_scroll_bottom(scroll_area_);
    int       new_y = cur_y + dy_view;
    if (new_y < 0)
        new_y = 0;
    if (new_y > max_y)
        new_y = max_y;
    if (new_y == cur_y)
        return;
    SyncRender(
        ctx,
        [this, new_y]() {
            lv_obj_scroll_to_y(scroll_area_, new_y, LV_ANIM_OFF);
            UpdateThumb();
        },
        false);
}

void DeviceInfoPage::UpdateThumb() {
    if (!thumb_ || !scroll_area_)
        return;
    lv_obj_update_layout(scroll_area_);
    const int scroll_y   = lv_obj_get_scroll_y(scroll_area_);
    const int scroll_bot = lv_obj_get_scroll_bottom(scroll_area_);
    const int max_scroll = scroll_y + scroll_bot;
    const int visible_h  = lv_obj_get_height(scroll_area_);
    ui::PositionScrollableThumb(thumb_,
                                {.y      = theme::kStatusBarHeight + theme::kScrollbarTrackPadTop,
                                 .height = LV_VER_RES - theme::kStatusBarHeight - theme::kScrollbarTrackPadTop -
                                           theme::kScrollbarTrackPadBottom},
                                visible_h, max_scroll, scroll_y);
}

void DeviceInfoPage::LoadStaticInfo() {
    cred::Credentials c;
    cred::Load(c);
    wifi_ssid_  = std::move(c.wifi_ssid);
    server_url_ = std::move(c.server_url);

    const std::string mac = util::WifiStaMacString(util::MacStringCase::kUpper);
    std::strncpy(mac_str_, mac.c_str(), sizeof(mac_str_) - 1);
    mac_str_[sizeof(mac_str_) - 1] = '\0';
}

bool DeviceInfoPage::Refresh(SceneContext& ctx) {
    if (!info_)
        return false;

    if (status_bar_)
        RefreshStatusBarFromSensors(ctx, *status_bar_);

    const bool        wifi_on        = ctx.wifi_connected ? ctx.wifi_connected() : false;
    const int         rssi_raw       = ctx.wifi_rssi ? ctx.wifi_rssi() : 0;
    const int         rssi           = (rssi_raw / 5) * 5;
    const std::string ip             = Wifi::Get().GetIp();
    int               battery_mv_raw = 0;
    int               battery_pct    = -1;
    if (ctx.read_battery)
        ctx.read_battery(&battery_mv_raw, &battery_pct);
    const int battery_mv = (battery_mv_raw / 50) * 50;

    ChargeStatus::Snapshot charge{};
    if (ctx.read_charge)
        charge = ctx.read_charge();

    auto round_kb_10   = [](size_t bytes) -> size_t { return (bytes / 1024 / 10) * 10; };
    auto round_kb_100  = [](size_t bytes) -> size_t { return (bytes / 1024 / 100) * 100; };
    auto available_pct = [](size_t available, size_t total) -> size_t {
        if (total == 0)
            return 0;
        return (available * 100 + total / 2) / total;
    };
    const size_t dram_free_kb   = round_kb_10(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    const size_t dram_total_kb  = round_kb_10(heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    const size_t psram_free_kb  = round_kb_100(heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    const size_t psram_total_kb = round_kb_100(heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    const size_t dram_free_pct  = available_pct(dram_free_kb, dram_total_kb);
    const size_t psram_free_pct = available_pct(psram_free_kb, psram_total_kb);

    size_t fs_total = 0;
    size_t fs_used  = 0;
    if (esp_littlefs_info("storage", &fs_total, &fs_used) != ESP_OK) {
        ESP_LOGW(kDeviceInfoTag, "littlefs info failed");
    }
    const size_t fs_total_kb = round_kb_100(fs_total);
    const size_t fs_free_kb  = round_kb_100(fs_total >= fs_used ? fs_total - fs_used : 0);
    const size_t fs_free_pct = available_pct(fs_free_kb, fs_total_kb);

    char buf[1024];
    std::snprintf(buf, sizeof(buf),
                  "WiFi    %s   %d dBm\n"
                  "SSID    %s\n"
                  "IP      %s\n"
                  "\n"
                  "电量    %d%%   %d mV\n"
                  "状态    %s\n"
                  "\n"
                  "DRAM    总量 %u KB，可用 %u KB（%u%%）\n"
                  "PSRAM   总量 %u KB，可用 %u KB（%u%%）\n"
                  "存储    总量 %u KB，可用 %u KB（%u%%）\n"
                  "\n"
                  "固件    %s\n"
                  "MAC     %s\n"
                  "服务器  %s",
                  wifi_on ? "已连接" : "未连接", rssi, wifi_ssid_.empty() ? "-" : wifi_ssid_.c_str(),
                  ip.empty() ? "-" : ip.c_str(), battery_pct < 0 ? 0 : battery_pct, battery_mv, ChargeText(charge),
                  static_cast<unsigned>(dram_total_kb), static_cast<unsigned>(dram_free_kb),
                  static_cast<unsigned>(dram_free_pct), static_cast<unsigned>(psram_total_kb),
                  static_cast<unsigned>(psram_free_kb), static_cast<unsigned>(psram_free_pct),
                  static_cast<unsigned>(fs_total_kb), static_cast<unsigned>(fs_free_kb),
                  static_cast<unsigned>(fs_free_pct), CONFIG_APP_PROJECT_VER, mac_str_,
                  server_url_.empty() ? "-" : server_url_.c_str());
    if (last_text_ == buf)
        return false;
    last_text_.assign(buf);
    lv_label_set_text(info_, buf);
    return true;
}

RestartDevicePage::RestartDevicePage()
    : ConfirmActionPage("restart_device", "重启设备",
                        "确认要重启设备吗？\n\n"
                        "Wi-Fi 配置和已下载\n"
                        "的内容缓存都保留\n"
                        "重启完成后自动恢复") {
}

RestartDevicePage::~RestartDevicePage() = default;

void RestartDevicePage::Confirm(SceneContext&) {
    ESP_LOGW(kRestartTag, "confirm action=restart_device");
    power_shutdown::GracefulRestart(200);
}

FactoryResetPage::FactoryResetPage()
    : ConfirmActionPage("factory_reset", "恢复出厂",
                        "确认要恢复出厂吗？\n\n"
                        "Wi-Fi 配置、设备绑定\n"
                        "小智配置及内容缓存\n"
                        "将全部清除\n"
                        "重启后进入配网模式") {
}

FactoryResetPage::~FactoryResetPage() = default;

void FactoryResetPage::Confirm(SceneContext&) {
    ESP_LOGW(kFactoryResetTag, "confirm action=factory_reset");
    cred::Clear();
    nvs_store::EraseNamespace(nvs_schema::kAudio);
    xiaozhi::settings::ClearAll();
    cache::FormatAll();
    power_shutdown::GracefulRestart(200);
}
