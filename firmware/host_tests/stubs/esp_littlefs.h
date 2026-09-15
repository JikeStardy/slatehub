#pragma once

#include <cstddef>

using esp_err_t = int;

inline constexpr esp_err_t ESP_OK                = 0;
inline constexpr esp_err_t ESP_ERR_INVALID_STATE = 0x103;

struct esp_vfs_littlefs_conf_t {
    const char* base_path = nullptr;
    const char* partition_label = nullptr;
    bool        format_if_mount_failed = false;
    bool        dont_mount = false;
};

inline esp_err_t esp_vfs_littlefs_register(const esp_vfs_littlefs_conf_t*) {
    return ESP_OK;
}

inline esp_err_t esp_vfs_littlefs_unregister(const char*) {
    return ESP_OK;
}

inline esp_err_t esp_littlefs_format(const char*) {
    return ESP_OK;
}

inline esp_err_t esp_littlefs_info(const char*, std::size_t* total, std::size_t* used) {
    if (total)
        *total = 16 * 1024 * 1024;
    if (used)
        *used = 0;
    return ESP_OK;
}

inline const char* esp_err_to_name(esp_err_t) {
    return "ESP_OK";
}

