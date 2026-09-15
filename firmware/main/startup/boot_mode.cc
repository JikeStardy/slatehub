#include "startup/boot_mode.h"

#include <esp_log.h>
#include <esp_sleep.h>

#include "bsp/board.h"
#include "bsp/config.h"
#include "storage/cache/cache.h"

namespace boot_mode {
namespace {
constexpr char kTag[] = "boot_mode";

WakeCause Classify(uint64_t& ext1_mask) {
    const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    switch (cause) {
        case ESP_SLEEP_WAKEUP_UNDEFINED:
            return WakeCause::kColdBoot;
        case ESP_SLEEP_WAKEUP_EXT1:
            ext1_mask = esp_sleep_get_ext1_wakeup_status();
            if (ext1_mask & ((1ULL << BOOT_BUTTON_GPIO) | (1ULL << DOWN_BUTTON_GPIO))) {
                return WakeCause::kButton;
            }
            if (ext1_mask & (1ULL << CHARGE_DETECT_GPIO)) {
                return WakeCause::kCharge;
            }
            ESP_LOGW(kTag, "wake source unknown cause=ext1 mask=0x%llx action=other", (unsigned long long)ext1_mask);
            return WakeCause::kOther;
        case ESP_SLEEP_WAKEUP_TIMER:
            return WakeCause::kRtcTimer;
        default:
            return WakeCause::kOther;
    }
}

const char* WakeReason(WakeCause cause) {
    switch (cause) {
        case WakeCause::kRtcTimer:
            return "timer";
        case WakeCause::kButton:
            return "button";
        case WakeCause::kCharge:
            return "charge";
        case WakeCause::kColdBoot:
            return "power_on";
        case WakeCause::kOther:
        default:
            return "other";
    }
}

bool HasCachedGroup() {
    cache::CachedGroupSummary summary;
    return cache::ReadCachedGroupSummary(summary, Board::Get().platform().Display());
}

}  // namespace

Decision Decide(const cred::Credentials& creds) {
    Decision d;
    d.first_register = creds.device_secret.empty();
    d.wake_cause     = Classify(d.ext1_mask);
    d.wake_reason    = WakeReason(d.wake_cause);

    if (creds.wifi_ssid.empty()) {
        d.mode = Mode::kPortal;
    } else if (d.wake_cause == WakeCause::kRtcTimer && !d.first_register && HasCachedGroup()) {
        d.mode = Mode::kBackgroundRefresh;
    } else {
        d.mode = Mode::kFullActive;
    }
    return d;
}

}  // namespace boot_mode
