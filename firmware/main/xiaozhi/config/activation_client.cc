#include "xiaozhi/config/activation_client.h"

#include <cJSON.h>
#include <esp_app_desc.h>
#include <esp_chip_info.h>
#include <esp_crt_bundle.h>
#include <esp_efuse.h>
#include <esp_efuse_table.h>
#include <esp_flash.h>
#ifdef SOC_HMAC_SUPPORTED
#include <esp_hmac.h>
#endif
#include <esp_heap_caps.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_psram.h>
#include <sys/time.h>

#include <cmath>
#include <cstring>

#include "bsp/board.h"
#include "utils/byte_utils.h"
#include "utils/json_utils.h"
#include "utils/mac_utils.h"
#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "xiaozhi_cfg";

esp_err_t HttpEventHandler(esp_http_client_event_t* evt) {
    auto* out = static_cast<std::string*>(evt->user_data);
    if (evt->event_id == HTTP_EVENT_ON_DATA && out && evt->data && evt->data_len > 0) {
        out->append(static_cast<const char*>(evt->data), evt->data_len);
    }
    return ESP_OK;
}

using json_utils::JsonInt;
using json_utils::JsonString;
using json_utils::PrintAndDelete;

std::string ActivationUrl() {
    std::string url = xiaozhi::ActivationClient::kConfigUrl;
    if (!url.empty() && url.back() != '/')
        url += '/';
    url += "activate";
    return url;
}
}  // namespace

namespace xiaozhi {

std::string ActivationClient::DeviceId() const {
    return util::WifiStaMacString();
}

std::string ActivationClient::UserAgent() const {
    const auto* app = esp_app_get_description();
    std::string ua  = Board::Get().platform().BoardId();
    ua += "/";
    ua += app ? app->version : "unknown";
    return ua;
}

std::string ActivationClient::SerialNumber() const {
#ifdef ESP_EFUSE_BLOCK_USR_DATA
    uint8_t serial_number[33] = {0};
    if (esp_efuse_read_field_blob(ESP_EFUSE_USER_DATA, serial_number, 32 * 8) == ESP_OK && serial_number[0] != 0) {
        serial_number[32] = 0;
        return std::string(reinterpret_cast<char*>(serial_number), 32);
    }
#endif
    return "";
}

std::string ActivationClient::SystemInfoJson() const {
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    const auto* app = esp_app_get_description();

    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 2);
    cJSON_AddStringToObject(root, "language", kLanguage);

    uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK)
        cJSON_AddNumberToObject(root, "flash_size", flash_size);
    cJSON_AddNumberToObject(root, "psram_size", esp_psram_get_size());
    cJSON_AddNumberToObject(root, "minimum_free_heap_size", esp_get_minimum_free_heap_size());
    cJSON_AddStringToObject(root, "mac_address", DeviceId().c_str());
    cJSON_AddStringToObject(root, "uuid", settings::GetUuid().c_str());
    cJSON_AddStringToObject(root, "chip_model_name", CONFIG_IDF_TARGET);

    cJSON* chip_info = cJSON_CreateObject();
    cJSON_AddNumberToObject(chip_info, "model", chip.model);
    cJSON_AddNumberToObject(chip_info, "cores", chip.cores);
    cJSON_AddNumberToObject(chip_info, "revision", chip.revision);
    cJSON_AddNumberToObject(chip_info, "features", chip.features);
    cJSON_AddItemToObject(root, "chip_info", chip_info);

    cJSON* application = cJSON_CreateObject();
    cJSON_AddStringToObject(application, "name", app ? app->project_name : "slate");
    cJSON_AddStringToObject(application, "version", app ? app->version : "unknown");
    std::string compile_time;
    if (app) {
        compile_time = std::string(app->date) + "T" + app->time + "Z";
        cJSON_AddStringToObject(application, "compile_time", compile_time.c_str());
        cJSON_AddStringToObject(application, "idf_version", app->idf_ver);
        cJSON_AddStringToObject(application, "elf_sha256",
                                util::HexLower(app->app_elf_sha256, sizeof(app->app_elf_sha256)).c_str());
    }
    cJSON_AddItemToObject(root, "application", application);

    cJSON*                   partitions = cJSON_CreateArray();
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, nullptr);
    while (it) {
        const esp_partition_t* partition = esp_partition_get(it);
        cJSON*                 item      = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "label", partition->label);
        cJSON_AddNumberToObject(item, "type", partition->type);
        cJSON_AddNumberToObject(item, "subtype", partition->subtype);
        cJSON_AddNumberToObject(item, "address", partition->address);
        cJSON_AddNumberToObject(item, "size", partition->size);
        cJSON_AddItemToArray(partitions, item);
        it = esp_partition_next(it);
    }
    esp_partition_iterator_release(it);
    cJSON_AddItemToObject(root, "partition_table", partitions);

    cJSON*                 ota     = cJSON_CreateObject();
    const esp_partition_t* running = esp_ota_get_running_partition();
    cJSON_AddStringToObject(ota, "label", running ? running->label : "unknown");
    cJSON_AddItemToObject(root, "ota", ota);

    const auto& display_info = Board::Get().platform().Display();
    cJSON*      display_json = cJSON_CreateObject();
    cJSON_AddBoolToObject(display_json, "monochrome",
                          display_info.frame.pixel_format == display::PixelFormat::kMono1);
    cJSON_AddNumberToObject(display_json, "width", display_info.frame.width);
    cJSON_AddNumberToObject(display_json, "height", display_info.frame.height);
    cJSON_AddStringToObject(display_json, "profile", display_info.profile_id);
    cJSON_AddItemToObject(root, "display", display_json);

    cJSON* board = cJSON_CreateObject();
    cJSON_AddStringToObject(board, "type", Board::Get().platform().BoardId());
    cJSON_AddStringToObject(board, "name", Board::Get().platform().BoardId());
    cJSON_AddStringToObject(board, "mac", DeviceId().c_str());
    cJSON_AddItemToObject(root, "board", board);

    return PrintAndDelete(root);
}

void ActivationClient::SetupHeaders(esp_http_client_handle_t client, const std::string& device_id,
                                    const std::string& client_id, const std::string& user_agent,
                                    const std::string& serial_number) const {
    esp_http_client_set_header(client, "Activation-Version", serial_number.empty() ? "1" : "2");
    esp_http_client_set_header(client, "Device-Id", device_id.c_str());
    esp_http_client_set_header(client, "Client-Id", client_id.c_str());
    if (!serial_number.empty())
        esp_http_client_set_header(client, "Serial-Number", serial_number.c_str());
    esp_http_client_set_header(client, "User-Agent", user_agent.c_str());
    esp_http_client_set_header(client, "Accept-Language", kLanguage);
    esp_http_client_set_header(client, "Content-Type", "application/json");
}

std::string ActivationClient::ActivationPayload(const std::string& challenge, const std::string& serial_number) const {
    if (serial_number.empty()) {
        ESP_LOGW(kTag, "activation payload empty reason=serial_number_missing");
        return "{}";
    }

    std::string hmac_hex;
#ifdef SOC_HMAC_SUPPORTED
    uint8_t   hmac_result[32] = {0};
    esp_err_t ret = esp_hmac_calculate(HMAC_KEY0, reinterpret_cast<const uint8_t*>(challenge.data()), challenge.size(),
                                       hmac_result);
    if (ret != ESP_OK) {
        ESP_LOGE(kTag, "activation hmac failed err=%s", esp_err_to_name(ret));
        return "{}";
    }
    hmac_hex = util::HexLower(hmac_result, sizeof(hmac_result));
#else
    ESP_LOGW(kTag, "activation hmac unsupported");
#endif

    cJSON* payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "algorithm", "hmac-sha256");
    cJSON_AddStringToObject(payload, "serial_number", serial_number.c_str());
    cJSON_AddStringToObject(payload, "challenge", challenge.c_str());
    cJSON_AddStringToObject(payload, "hmac", hmac_hex.c_str());
    return PrintAndDelete(payload);
}

esp_err_t ActivationClient::Activate(const std::string& challenge) {
    if (challenge.empty()) {
        ESP_LOGW(kTag, "activate skipped reason=challenge_empty");
        return ESP_FAIL;
    }

    std::string       body;
    const std::string device_id     = DeviceId();
    const std::string client_id     = settings::GetUuid();
    const std::string user_agent    = UserAgent();
    const std::string serial_number = SerialNumber();
    const std::string payload       = ActivationPayload(challenge, serial_number);
    const std::string url           = ActivationUrl();

    esp_http_client_config_t cfg = {};
    cfg.url                      = url.c_str();
    cfg.method                   = HTTP_METHOD_POST;
    cfg.timeout_ms               = 15000;
    cfg.crt_bundle_attach        = esp_crt_bundle_attach;
    cfg.event_handler            = HttpEventHandler;
    cfg.user_data                = &body;
    cfg.disable_auto_redirect    = false;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client)
        return ESP_FAIL;
    SetupHeaders(client, device_id, client_id, user_agent, serial_number);
    esp_http_client_set_post_field(client, payload.c_str(), payload.size());

    esp_err_t err    = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "activate failed err=%s status=%d body_len=%u", esp_err_to_name(err), status,
                 static_cast<unsigned>(body.size()));
    }
    esp_http_client_cleanup(client);

    if (err != ESP_OK)
        return err;
    if (status == 202)
        return ESP_ERR_TIMEOUT;
    return status == 200 ? ESP_OK : ESP_FAIL;
}

ActivationConfigResult ActivationClient::Fetch() {
    ActivationConfigResult result;
    std::string            body;
    std::string            request       = SystemInfoJson();
    const std::string      device_id     = DeviceId();
    const std::string      client_id     = settings::GetUuid();
    const std::string      user_agent    = UserAgent();
    const std::string      serial_number = SerialNumber();

    esp_http_client_config_t cfg = {};
    cfg.url                      = kConfigUrl;
    cfg.method                   = HTTP_METHOD_POST;
    cfg.timeout_ms               = 15000;
    cfg.crt_bundle_attach        = esp_crt_bundle_attach;
    cfg.event_handler            = HttpEventHandler;
    cfg.user_data                = &body;
    cfg.disable_auto_redirect    = false;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        result.error = "HTTP 初始化失败";
        return result;
    }
    SetupHeaders(client, device_id, client_id, user_agent, serial_number);
    esp_http_client_set_post_field(client, request.c_str(), request.size());

    esp_err_t err      = esp_http_client_perform(client);
    result.http_status = esp_http_client_get_status_code(client);
    if (err != ESP_OK) {
        result.error = esp_err_to_name(err);
        ESP_LOGW(kTag, "fetch failed err=%s", result.error.c_str());
        esp_http_client_cleanup(client);
        return result;
    }
    esp_http_client_cleanup(client);

    if (result.http_status != 200) {
        result.error = "HTTP " + std::to_string(result.http_status);
        ESP_LOGW(kTag, "fetch failed status=%d body_len=%u", result.http_status, static_cast<unsigned>(body.size()));
        return result;
    }

    cJSON* root = cJSON_Parse(body.c_str());
    if (!root) {
        result.error = "配置响应不是 JSON";
        return result;
    }

    if (cJSON* activation = cJSON_GetObjectItem(root, "activation"); cJSON_IsObject(activation)) {
        result.activation_message       = JsonString(activation, "message");
        result.activation_code          = JsonString(activation, "code");
        result.has_activation           = !result.activation_code.empty();
        result.activation_challenge     = JsonString(activation, "challenge");
        result.has_activation_challenge = !result.activation_challenge.empty();
        result.activation_timeout_ms    = JsonInt(activation, "timeout_ms", 30000);
    }

    if (cJSON* mqtt = cJSON_GetObjectItem(root, "mqtt"); cJSON_IsObject(mqtt)) {
        settings::MqttConfig m;
        m.endpoint      = JsonString(mqtt, "endpoint");
        m.client_id     = JsonString(mqtt, "client_id");
        m.username      = JsonString(mqtt, "username");
        m.password      = JsonString(mqtt, "password");
        m.publish_topic = JsonString(mqtt, "publish_topic");
        m.keepalive     = JsonInt(mqtt, "keepalive", 240);
        if (settings::SaveMqtt(m)) {
            result.has_protocol = true;
        }
    }

    if (cJSON* websocket = cJSON_GetObjectItem(root, "websocket"); cJSON_IsObject(websocket)) {
        settings::WebsocketConfig ws;
        ws.url     = JsonString(websocket, "url");
        ws.token   = JsonString(websocket, "token");
        ws.version = JsonInt(websocket, "version", 0);
        if (settings::SaveWebsocket(ws)) {
            result.has_protocol = true;
        }
    }

    if (cJSON* server_time = cJSON_GetObjectItem(root, "server_time"); cJSON_IsObject(server_time)) {
        cJSON* timestamp       = cJSON_GetObjectItem(server_time, "timestamp");
        cJSON* timezone_offset = cJSON_GetObjectItem(server_time, "timezone_offset");
        if (cJSON_IsNumber(timestamp)) {
            int64_t ts_ms = static_cast<int64_t>(std::llround(timestamp->valuedouble));
            if (cJSON_IsNumber(timezone_offset)) {
                ts_ms += static_cast<int64_t>(timezone_offset->valueint) * 60 * 1000;
            }
            timeval tv = {};
            tv.tv_sec  = static_cast<time_t>(ts_ms / 1000);
            tv.tv_usec = static_cast<suseconds_t>(ts_ms % 1000) * 1000;
            if (settimeofday(&tv, nullptr) == 0) {
                result.server_time_synced = true;
            }
        }
    }

    cJSON_Delete(root);
    result.ok           = true;
    result.has_protocol = result.has_protocol || settings::HasProtocolConfig();
    return result;
}

}  // namespace xiaozhi
