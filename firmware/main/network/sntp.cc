#include "network/sntp.h"

#include <esp_log.h>
#include <esp_netif_sntp.h>
#include <esp_sntp.h>
#include <sdkconfig.h>

#include <sys/time.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>

namespace {
constexpr char kTag[] = "sntp";

constexpr time_t kSyncedAfterEpoch = 1577836800;  // 2020-01-01 UTC
constexpr long   kMaxClockDriftSec = 10;

bool IsLeap(int year) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

bool ValidDateTime(int year, int month, int day, int hour, int minute, int second) {
    if (year < 2020 || month < 1 || month > 12 || day < 1)
        return false;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
        return false;
    }
    static constexpr int kMonthDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int                  max_day      = kMonthDays[month - 1];
    if (month == 2 && IsLeap(year))
        ++max_day;
    return day <= max_day;
}

int64_t DaysFromCivil(int year, unsigned month, unsigned day) {
    year -= month <= 2;
    const int      era           = (year >= 0 ? year : year - 399) / 400;
    const unsigned yoe           = static_cast<unsigned>(year - era * 400);
    const int      shifted_month = static_cast<int>(month) + (month > 2 ? -3 : 9);
    const unsigned doy           = static_cast<unsigned>((153 * shifted_month + 2) / 5) + day - 1;
    const unsigned doe           = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe) - 719468;
}

bool ParseIsoUtc(const std::string& iso, time_t& out) {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    int consumed = 0;
    if (std::sscanf(iso.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &year, &month, &day, &hour, &minute, &second,
                    &consumed) != 6) {
        return false;
    }
    if (!ValidDateTime(year, month, day, hour, minute, second))
        return false;

    int    offset_sec = 0;
    size_t pos        = static_cast<size_t>(consumed);
    if (pos < iso.size() && iso[pos] == '.') {
        ++pos;
        while (pos < iso.size() && iso[pos] >= '0' && iso[pos] <= '9')
            ++pos;
    }
    if (pos < iso.size()) {
        if (iso[pos] == 'Z') {
            ++pos;
        } else if (iso[pos] == '+' || iso[pos] == '-') {
            const int sign        = iso[pos] == '+' ? 1 : -1;
            int       tz_hour     = 0;
            int       tz_minute   = 0;
            int       tz_consumed = 0;
            if (std::sscanf(iso.c_str() + pos + 1, "%2d:%2d%n", &tz_hour, &tz_minute, &tz_consumed) != 2 ||
                tz_consumed != 5 || tz_hour < 0 || tz_hour > 23 || tz_minute < 0 || tz_minute > 59) {
                return false;
            }
            offset_sec = sign * (tz_hour * 3600 + tz_minute * 60);
            pos += 1 + static_cast<size_t>(tz_consumed);
        } else {
            return false;
        }
    }
    if (pos != iso.size())
        return false;

    const int64_t days = DaysFromCivil(year, static_cast<unsigned>(month), static_cast<unsigned>(day));
    out                = static_cast<time_t>(days * 86400 + hour * 3600 + minute * 60 + second - offset_sec);
    return out > kSyncedAfterEpoch;
}
}  // namespace

namespace sntp {

void Init() {
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    cfg.start             = true;
    esp_netif_sntp_init(&cfg);

    setenv("TZ", CONFIG_SLATEHUB_DEFAULT_TIMEZONE, 1);
    tzset();
}

bool TimeSynced() {
    time_t now = time(nullptr);
    return now > kSyncedAfterEpoch;
}

void ApplyServerTime(const std::string& iso) {
    if (iso.empty())
        return;
    time_t server = 0;
    if (!ParseIsoUtc(iso, server)) {
        ESP_LOGW(kTag, "server time parse failed value=%s", iso.c_str());
        return;
    }
    const time_t now  = time(nullptr);
    const long   diff = static_cast<long>(server - now);
    if (TimeSynced() && std::labs(diff) <= kMaxClockDriftSec)
        return;

    timeval tv{};
    tv.tv_sec = server;
    if (settimeofday(&tv, nullptr) != 0) {
        ESP_LOGW(kTag, "set time failed");
    }
}

}  // namespace sntp
