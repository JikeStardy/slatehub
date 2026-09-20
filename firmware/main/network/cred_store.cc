#include "network/cred_store.h"

#include <esp_log.h>

#include "storage/nvs/nvs_schema.h"
#include "storage/nvs/nvs_store.h"

namespace {
constexpr char kTag[] = "cred";
}  // namespace

namespace cred {

bool Load(Credentials& out) {
    nvs_store::GetStrings(nvs_schema::kNet, {
                                                {nvs_schema::net::kSsid, &out.wifi_ssid},
                                                {nvs_schema::net::kPwd, &out.wifi_pwd},
                                                {nvs_schema::net::kUrl, &out.server_url},
                                                {nvs_schema::net::kDevId, &out.device_id},
                                                {nvs_schema::net::kDevSec, &out.device_secret},
                                            });
    return !out.wifi_ssid.empty() && !out.server_url.empty();
}

bool Save(const Credentials& c) {
    bool ok = nvs_store::SetStrings(nvs_schema::kNet, {
                                                          {nvs_schema::net::kSsid, c.wifi_ssid},
                                                          {nvs_schema::net::kPwd, c.wifi_pwd},
                                                          {nvs_schema::net::kUrl, c.server_url},
                                                      });
    if (!ok) {
        ESP_LOGE(kTag, "save failed type=credentials");
    }
    return ok;
}

bool SaveSecret(const std::string& device_id, const std::string& device_secret) {
    bool ok = nvs_store::SetStrings(nvs_schema::kNet, {
                                                          {nvs_schema::net::kDevId, device_id},
                                                          {nvs_schema::net::kDevSec, device_secret},
                                                      });
    if (!ok) {
        ESP_LOGE(kTag, "save failed type=secret");
        return false;
    }
    return true;
}

void ClearSecret() {
    // 保留 Wi-Fi 和 server url，只清内容服务端设备身份。
    nvs_store::EraseKey(nvs_schema::kNet, nvs_schema::net::kDevId);
    nvs_store::EraseKey(nvs_schema::kNet, nvs_schema::net::kDevSec);
    ESP_LOGW(kTag, "secret cleared action=reregister_next_boot");
}

std::string GetServerUrl() {
    return nvs_store::GetString(nvs_schema::kNet, nvs_schema::net::kUrl);
}

void Clear() {
    nvs_store::EraseNamespace(nvs_schema::kNet);
}

}  // namespace cred
