#include "xiaozhi/config/settings.h"

#include <esp_random.h>

#include <cstdio>

#include "storage/nvs/nvs_schema.h"
#include "storage/nvs/nvs_store.h"
#include "storage/nvs/volume_store.h"

namespace {
std::string GenerateUuid() {
    uint8_t uuid[16];
    esp_fill_random(uuid, sizeof(uuid));
    uuid[6] = (uuid[6] & 0x0F) | 0x40;
    uuid[8] = (uuid[8] & 0x3F) | 0x80;
    char out[37];
    std::snprintf(out, sizeof(out), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", uuid[0],
                  uuid[1], uuid[2], uuid[3], uuid[4], uuid[5], uuid[6], uuid[7], uuid[8], uuid[9], uuid[10], uuid[11],
                  uuid[12], uuid[13], uuid[14], uuid[15]);
    return out;
}

bool LoadMqttFromNamespace(const char* ns, xiaozhi::settings::MqttConfig& out) {
    nvs_store::GetStrings(ns, {
                                  {nvs_schema::mqtt::kEndpoint, &out.endpoint},
                                  {nvs_schema::mqtt::kClientId, &out.client_id},
                                  {nvs_schema::mqtt::kUsername, &out.username},
                                  {nvs_schema::mqtt::kPassword, &out.password},
                                  {nvs_schema::mqtt::kPubTopic, &out.publish_topic},
                              });
    out.keepalive = nvs_store::GetInt32(ns, nvs_schema::mqtt::kKeepalive, 240);
    return !out.endpoint.empty() && !out.client_id.empty() && !out.publish_topic.empty();
}

bool LoadWebsocketFromNamespace(const char* ns, xiaozhi::settings::WebsocketConfig& out) {
    nvs_store::GetStrings(ns, {
                                  {nvs_schema::ws::kUrl, &out.url},
                                  {nvs_schema::ws::kToken, &out.token},
                              });
    out.version = nvs_store::GetInt32(ns, nvs_schema::ws::kVersion, 0);
    return !out.url.empty();
}
}  // namespace

namespace xiaozhi {
namespace settings {

std::string GetUuid() {
    std::string uuid = nvs_store::GetString(nvs_schema::kXiaozhi, nvs_schema::xiaozhi::kUuid);
    if (!uuid.empty())
        return uuid;
    uuid = GenerateUuid();
    nvs_store::SetString(nvs_schema::kXiaozhi, nvs_schema::xiaozhi::kUuid, uuid);
    return uuid;
}

bool SaveMqtt(const MqttConfig& cfg) {
    bool ok = true;
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kEndpoint, cfg.endpoint);
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kClientId, cfg.client_id);
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kUsername, cfg.username);
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kPassword, cfg.password);
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kPubTopic, cfg.publish_topic);
    ok &= nvs_store::SetInt32(nvs_schema::kXiaozhiMqtt, nvs_schema::mqtt::kKeepalive, cfg.keepalive);
    const bool valid = ok && !cfg.endpoint.empty() && !cfg.client_id.empty() && !cfg.publish_topic.empty();
    return valid;
}

bool LoadMqtt(MqttConfig& out) {
    return LoadMqttFromNamespace(nvs_schema::kXiaozhiMqtt, out);
}

void ClearMqtt() {
    nvs_store::EraseNamespace(nvs_schema::kXiaozhiMqtt);
}

bool SaveWebsocket(const WebsocketConfig& cfg) {
    bool ok = true;
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiWs, nvs_schema::ws::kUrl, cfg.url);
    ok &= nvs_store::SetString(nvs_schema::kXiaozhiWs, nvs_schema::ws::kToken, cfg.token);
    ok &= nvs_store::SetInt32(nvs_schema::kXiaozhiWs, nvs_schema::ws::kVersion, cfg.version);
    const bool valid = ok && !cfg.url.empty();
    return valid;
}

bool LoadWebsocket(WebsocketConfig& out) {
    return LoadWebsocketFromNamespace(nvs_schema::kXiaozhiWs, out);
}

void ClearWebsocket() {
    nvs_store::EraseNamespace(nvs_schema::kXiaozhiWs);
}

bool HasProtocolConfig() {
    if (nvs_store::HasStrings(nvs_schema::kXiaozhiMqtt,
                              {nvs_schema::mqtt::kEndpoint, nvs_schema::mqtt::kClientId, nvs_schema::mqtt::kPubTopic}))
        return true;
    return nvs_store::HasString(nvs_schema::kXiaozhiWs, nvs_schema::ws::kUrl);
}

int GetVolume() {
    return vol::Get();
}

void SetVolume(int level) {
    vol::Set(level);
}

void ClearAll() {
    nvs_store::EraseNamespace(nvs_schema::kXiaozhi);
    nvs_store::EraseNamespace(nvs_schema::kXiaozhiMqtt);
    nvs_store::EraseNamespace(nvs_schema::kXiaozhiWs);
}

}  // namespace settings
}  // namespace xiaozhi
