#include "network/wifi.h"

#include <esp_log.h>
#include <esp_mac.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <utility>

#include "utils/time_utils.h"

namespace {
constexpr char kTag[]                 = "wifi";
constexpr int  kWifiBitConnected      = BIT0;
constexpr int  kWifiBitConnectionFail = BIT1;

EventGroupHandle_t& WifiEventGroup() {
    static EventGroupHandle_t s_event_group = nullptr;
    return s_event_group;
}

void EnsureWifiEventGroup() {
    auto& event_group = WifiEventGroup();
    if (!event_group)
        event_group = xEventGroupCreate();
    configASSERT(event_group != nullptr);
}

bool FillStaConfig(wifi_config_t& wc, const std::string& ssid, const std::string& password, std::string* reason) {
    wc = {};
    if (ssid.empty()) {
        if (reason)
            *reason = "SSID 不能为空";
        return false;
    }
    if (ssid.size() > sizeof(wc.sta.ssid)) {
        if (reason)
            *reason = "SSID 过长";
        return false;
    }
    if (password.size() >= sizeof(wc.sta.password)) {
        if (reason)
            *reason = "Wi-Fi 密码过长";
        return false;
    }
    if (!password.empty() && password.size() < 8) {
        if (reason)
            *reason = "Wi-Fi 密码至少 8 位；开放网络请留空";
        return false;
    }
    std::memcpy(wc.sta.ssid, ssid.data(), ssid.size());
    std::memcpy(wc.sta.password, password.data(), password.size());
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable    = true;
    wc.sta.pmf_cfg.required   = false;
    return true;
}

std::string DisconnectReasonZh(int reason) {
    switch (reason) {
        case 1:
            return "未指定原因";
        case 2:
            return "auth 失败";
        case 3:
            return "路由器主动断开(auth)";
        case 4:
            return "associate 超时";
        case 5:
            return "AP 客户端过多";
        case 6:
            return "未认证";
        case 7:
            return "未关联";
        case 8:
            return "本机断开(assoc-leave,常见于配置切换)";
        case 14:
            return "MIC 失败,密码错";
        case 15:
            return "4-way handshake 超时(密码错)";
        case 200:
            return "信号弱或路由器无 beacon";
        case 201:
            return "未找到该 SSID";
        case 202:
            return "认证失败,密码错";
        case 203:
            return "associate 失败";
        case 204:
            return "握手超时";
        case 205:
            return "连接失败";
        default: {
            char buf[48];
            std::snprintf(buf, sizeof(buf), "连接失败 (reason=%d)", reason);
            return buf;
        }
    }
}
}  // namespace

Wifi& Wifi::Get() {
    static Wifi w;
    return w;
}

void Wifi::EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data) {
    Wifi* self = static_cast<Wifi*>(arg);

    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_DISCONNECTED) {
            auto*      d              = static_cast<wifi_event_sta_disconnected_t*>(data);
            const bool want_reconnect = self->want_reconnect_.load(std::memory_order_acquire);
            const int  fail_count     = self->fail_count_.load(std::memory_order_acquire);
            ESP_LOGW(kTag, "sta disconnected reason=%d want_reconnect=%d fail_count=%d max_fast_fail=%d", d->reason,
                     want_reconnect, fail_count, self->max_fast_fail_);
            self->last_disconnect_reason_.store(d->reason, std::memory_order_release);
            DisconnectCb on_disconnect;
            {
                std::lock_guard<std::mutex> lock(self->callback_mutex_);
                on_disconnect = self->on_disconnect_;
            }
            if (on_disconnect)
                on_disconnect(d->reason);

            if (!want_reconnect) {
                self->state_.store(State::Disconnected);
                xEventGroupSetBits(WifiEventGroup(), kWifiBitConnectionFail);
                return;
            }

            if (fail_count < self->max_fast_fail_) {
                self->fail_count_.fetch_add(1, std::memory_order_acq_rel);
                esp_err_t e = esp_wifi_connect();
                if (e != ESP_OK) {
                    ESP_LOGW(kTag, "sta reconnect failed err=%s", esp_err_to_name(e));
                }
                return;
            }

            self->state_.store(State::Disconnected);
            xEventGroupSetBits(WifiEventGroup(), kWifiBitConnectionFail);
            self->reconnect_.Schedule();
            return;
        }

        if (id == WIFI_EVENT_SCAN_DONE) {
            if (self->reconnect_.ConsumeSlowScanPending()) {
                self->reconnect_.HandleSlowScanResult();
            }
            return;
        }
        return;
    }

    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* e = static_cast<ip_event_got_ip_t*>(data);
        char  ip[INET6_ADDRSTRLEN];
        std::snprintf(ip, sizeof(ip), IPSTR, IP2STR(&e->ip_info.ip));
        self->SetIpString(ip);
        self->fail_count_.store(0, std::memory_order_release);
        self->reconnect_.ResetBackoff();
        self->reconnect_.Stop();
        self->state_.store(State::Connected);
        xEventGroupSetBits(WifiEventGroup(), kWifiBitConnected);
        return;
    }
}

void Wifi::RegisterEventHandlers() {
    if (handler_wifi_ || handler_ip_)
        return;
    ESP_ERROR_CHECK(
        esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &EventHandler, this, &handler_wifi_));
    ESP_ERROR_CHECK(
        esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &EventHandler, this, &handler_ip_));
}

void Wifi::UnregisterEventHandlers() {
    if (handler_wifi_) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, handler_wifi_);
        handler_wifi_ = nullptr;
    }
    if (handler_ip_) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, handler_ip_);
        handler_ip_ = nullptr;
    }
}

void Wifi::Init() {
    std::lock_guard<std::mutex> init_lock(init_mutex_);
    if (inited_)
        return;

    esp_err_t err = esp_netif_init();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);
    err = esp_event_loop_create_default();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    cfg.nvs_enable         = false;
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    EnsureWifiEventGroup();
    inited_ = true;
}

bool Wifi::Connect(const std::string& ssid, const std::string& password, int timeout_ms) {
    Init();
    if (ssid.empty()) {
        ESP_LOGW(kTag, "connect failed reason=ssid_empty");
        return false;
    }
    if (mode_.load(std::memory_order_acquire) == Mode::AccessPoint)
        StopApInternal();
    if (mode_.load(std::memory_order_acquire) != Mode::Station)
        StartStationInternal();

    wifi_config_t wc = {};
    if (!FillStaConfig(wc, ssid, password, nullptr)) {
        ESP_LOGW(kTag, "connect failed reason=invalid_credentials ssid_len=%u password_len=%u",
                 static_cast<unsigned>(ssid.size()), static_cast<unsigned>(password.size()));
        return false;
    }
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    state_.store(State::Connecting);
    fail_count_.store(0, std::memory_order_release);
    reconnect_.ResetBackoff();
    want_reconnect_.store(true, std::memory_order_release);

    xEventGroupClearBits(WifiEventGroup(), kWifiBitConnected | kWifiBitConnectionFail);
    esp_wifi_disconnect();
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(WifiEventGroup(), kWifiBitConnected | kWifiBitConnectionFail, pdFALSE,
                                           pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (bits & kWifiBitConnected) {
        esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
        return true;
    }

    ESP_LOGW(kTag, "connect failed reason=timeout_or_fail last_reason=%d action=disable_auto_reconnect",
             last_disconnect_reason_.load(std::memory_order_acquire));
    want_reconnect_.store(false, std::memory_order_release);
    reconnect_.Stop();
    state_.store(State::Disconnected);
    return false;
}

bool Wifi::TryConnect(const std::string& ssid, const std::string& password, int timeout_ms, std::string& out_reason) {
    Init();
    if (ssid.empty()) {
        out_reason = "SSID 不能为空";
        return false;
    }
    if (mode_.load(std::memory_order_acquire) != Mode::AccessPoint) {
        out_reason = "TryConnect 必须在配网模式下调用";
        ESP_LOGE(kTag, "try connect failed reason=not_ap_mode");
        return false;
    }
    want_reconnect_.store(false, std::memory_order_release);
    fail_count_.store(0, std::memory_order_release);
    last_disconnect_reason_.store(0, std::memory_order_release);
    reconnect_.Stop();

    wifi_config_t wc = {};
    if (!FillStaConfig(wc, ssid, password, &out_reason))
        return false;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    constexpr int kMaxAttempts         = 3;
    constexpr int kPerAttemptTimeoutMs = 8000;
    const int     total_budget         = std::max(timeout_ms, kPerAttemptTimeoutMs);
    const int64_t deadline_ms          = time_utils::NowMs() + total_budget;

    int last_reason = 0;
    for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
        const int64_t now_ms      = time_utils::NowMs();
        const int     budget_left = static_cast<int>(deadline_ms - now_ms);
        if (budget_left <= 0)
            break;
        const int wait_ms = std::min(budget_left, kPerAttemptTimeoutMs);

        xEventGroupClearBits(WifiEventGroup(), kWifiBitConnected | kWifiBitConnectionFail);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "try connect attempt failed attempt=%d err=%s", attempt, esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(300));
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(WifiEventGroup(), kWifiBitConnected | kWifiBitConnectionFail, pdFALSE,
                                               pdFALSE, pdMS_TO_TICKS(wait_ms));

        if (bits & kWifiBitConnected) {
            esp_wifi_disconnect();
            state_.store(State::Idle);
            xEventGroupClearBits(WifiEventGroup(), kWifiBitConnected | kWifiBitConnectionFail);
            return true;
        }
        if (bits & kWifiBitConnectionFail) {
            last_reason = last_disconnect_reason_.load(std::memory_order_acquire);
            ESP_LOGW(kTag, "try connect attempt failed attempt=%d reason=%d", attempt, last_reason);
            vTaskDelay(pdMS_TO_TICKS(300));
        } else {
            ESP_LOGW(kTag, "try connect attempt timeout attempt=%d timeout_ms=%d", attempt, wait_ms);
            esp_wifi_disconnect();
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }

    if (last_reason != 0) {
        out_reason = DisconnectReasonZh(last_reason);
    } else {
        out_reason = "连接超时,可能信号弱或路由器无响应";
    }
    esp_wifi_disconnect();
    ESP_LOGW(kTag, "try connect failed reason=%s", out_reason.c_str());
    return false;
}

void Wifi::Disconnect() {
    want_reconnect_.store(false, std::memory_order_release);
    reconnect_.Stop();
    if (mode_.load(std::memory_order_acquire) == Mode::Station)
        esp_wifi_disconnect();
    state_.store(State::Disconnected);
}

bool Wifi::IsConnected() const {
    return state_.load() == State::Connected;
}

int8_t Wifi::GetRssi() const {
    if (!IsConnected())
        return 0;
    wifi_ap_record_t r;
    if (esp_wifi_sta_get_ap_info(&r) == ESP_OK)
        return r.rssi;
    return 0;
}

std::string Wifi::GetIp() const {
    std::lock_guard<std::mutex> lock(ip_mutex_);
    return ip_str_;
}

void Wifi::SetIpString(const char* ip) {
    std::lock_guard<std::mutex> lock(ip_mutex_);
    std::snprintf(ip_str_, sizeof(ip_str_), "%s", ip ? ip : "");
}

void Wifi::ClearIpString() {
    SetIpString("");
}

bool Wifi::ReconnectAllowed() const {
    return want_reconnect_.load(std::memory_order_acquire);
}

bool Wifi::StationModeActive() const {
    return mode_.load(std::memory_order_acquire) == Mode::Station;
}

void Wifi::MarkSlowReconnectConnecting() {
    state_.store(State::Connecting);
}

void Wifi::ResetFastFailCount() {
    fail_count_.store(0, std::memory_order_release);
}

bool Wifi::StartAp(const std::string& ssid_prefix) {
    Init();
    if (mode_.load(std::memory_order_acquire) == Mode::AccessPoint) {
        ESP_LOGW(kTag, "start ap ignored reason=already_ap_mode");
        return true;
    }
    StartApInternal(ssid_prefix);
    return true;
}

void Wifi::StopAp() {
    StopApInternal();
}

void Wifi::OnDisconnected(DisconnectCb cb) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    on_disconnect_ = std::move(cb);
}

void Wifi::StartStationInternal() {
    sta_netif_ = esp_netif_create_default_wifi_sta();
    RegisterEventHandlers();
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    mode_.store(Mode::Station, std::memory_order_release);
}

void Wifi::StopStationInternal() {
    if (mode_.load(std::memory_order_acquire) != Mode::Station)
        return;
    reconnect_.Stop();
    UnregisterEventHandlers();
    esp_wifi_disconnect();
    esp_wifi_stop();
    if (sta_netif_) {
        esp_netif_destroy_default_wifi(sta_netif_);
        sta_netif_ = nullptr;
    }
    state_.store(State::Idle);
    want_reconnect_.store(false, std::memory_order_release);
    ClearIpString();
    mode_.store(Mode::Off, std::memory_order_release);
}

void Wifi::StartApInternal(const std::string& ssid_prefix) {
    if (mode_.load(std::memory_order_acquire) == Mode::Station)
        StopStationInternal();

    ap_netif_  = esp_netif_create_default_wifi_ap();
    sta_netif_ = esp_netif_create_default_wifi_sta();
    RegisterEventHandlers();

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[32];
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", ssid_prefix.c_str(), mac[4], mac[5]);

    wifi_config_t apc = {};
    std::strncpy(reinterpret_cast<char*>(apc.ap.ssid), ssid, sizeof(apc.ap.ssid) - 1);
    apc.ap.ssid_len        = std::strlen(ssid);
    apc.ap.channel         = 6;
    apc.ap.max_connection  = 4;
    apc.ap.authmode        = WIFI_AUTH_OPEN;
    apc.ap.beacon_interval = 100;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &apc));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(kTag, "ap started ssid=%s", ssid);
    mode_.store(Mode::AccessPoint, std::memory_order_release);
}

void Wifi::StopApInternal() {
    if (mode_.load(std::memory_order_acquire) != Mode::AccessPoint)
        return;
    reconnect_.Stop();
    UnregisterEventHandlers();
    esp_wifi_disconnect();
    esp_wifi_stop();
    if (ap_netif_) {
        esp_netif_destroy_default_wifi(ap_netif_);
        ap_netif_ = nullptr;
    }
    if (sta_netif_) {
        esp_netif_destroy_default_wifi(sta_netif_);
        sta_netif_ = nullptr;
    }
    state_.store(State::Idle);
    want_reconnect_.store(false, std::memory_order_release);
    ClearIpString();
    mode_.store(Mode::Off, std::memory_order_release);
}
