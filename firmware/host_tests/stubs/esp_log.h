#pragma once

namespace esp_log_stub {

template <typename... Args>
inline void Log(const char*, const char*, Args&&...) {
}

}  // namespace esp_log_stub

#define ESP_LOGW(tag, fmt, ...) ::esp_log_stub::Log(tag, fmt, ##__VA_ARGS__)
#define ESP_LOGE(tag, fmt, ...) ::esp_log_stub::Log(tag, fmt, ##__VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) ::esp_log_stub::Log(tag, fmt, ##__VA_ARGS__)
