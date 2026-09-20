#include "xiaozhi/mcp/mcp_dispatcher.h"

#include <esp_app_desc.h>
#include <esp_log.h>

#include <algorithm>

#include "storage/nvs/volume_store.h"
#include "utils/json_utils.h"
#include "xiaozhi/mcp/mcp_tools.h"

namespace xiaozhi::mcp {
namespace {

constexpr char kTag[] = "xiaozhi_mcp";

using json_utils::JsonId;
using json_utils::JsonString;

void Send(const Dispatcher& dispatcher, const std::string& payload) {
    if (dispatcher.send)
        dispatcher.send(payload);
}

std::string InitializeResultJson() {
    const auto* app = esp_app_get_description();
    std::string result =
        "{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},"
        "\"serverInfo\":{\"name\":\"slatehub\",\"version\":\"";
    result += app ? app->version : "unknown";
    result += "\"}}";
    return result;
}

}  // namespace

bool DispatchMessage(const cJSON* root, const Dispatcher& dispatcher) {
    cJSON* payload = cJSON_GetObjectItem(root, "payload");
    if (!cJSON_IsObject(payload))
        return false;

    const std::string method = JsonString(payload, "method");
    const std::string id     = JsonId(cJSON_GetObjectItem(payload, "id"));

    if (method.rfind("notifications", 0) == 0)
        return true;

    if (id.empty()) {
        ESP_LOGW(kTag, "request ignored reason=id_missing method=%s", method.c_str());
        return true;
    }

    if (method == "initialize") {
        Send(dispatcher, JsonRpcResult(id, InitializeResultJson()));
        return true;
    }

    if (method == "tools/list") {
        Send(dispatcher, JsonRpcResult(id, ToolListResultJson()));
        return true;
    }

    if (method == "tools/call") {
        cJSON* params = cJSON_GetObjectItem(payload, "params");
        if (!cJSON_IsObject(params)) {
            Send(dispatcher, JsonRpcError(id, -32602, "Missing params"));
            return true;
        }
        cJSON* name = cJSON_GetObjectItem(params, "name");
        if (!cJSON_IsString(name) || !name->valuestring) {
            Send(dispatcher, JsonRpcError(id, -32602, "Missing tool name"));
            return true;
        }
        const std::string tool_name = name->valuestring;
        if (tool_name == "self.get_device_status") {
            const std::string status_json = dispatcher.device_status_json ? dispatcher.device_status_json() : "{}";
            Send(dispatcher, JsonRpcResult(id, TextResultJson(status_json)));
            return true;
        }
        if (tool_name == "self.audio_speaker.set_volume") {
            cJSON* arguments = cJSON_GetObjectItem(params, "arguments");
            cJSON* volume    = cJSON_IsObject(arguments) ? cJSON_GetObjectItem(arguments, "volume") : nullptr;
            if (!cJSON_IsNumber(volume)) {
                Send(dispatcher, JsonRpcError(id, -32602, "Missing volume"));
                return true;
            }
            const int codec_volume = std::clamp(volume->valueint, 0, 100);
            const int level        = std::clamp((codec_volume + 5) / 10, 0, vol::kMax);
            if (dispatcher.set_volume)
                dispatcher.set_volume(level);
            Send(dispatcher, JsonRpcResult(id, TextResultJson("true")));
            return true;
        }
        Send(dispatcher, JsonRpcError(id, -32601, "Unknown tool: " + tool_name));
        return true;
    }

    Send(dispatcher, JsonRpcError(id, -32601, "Method not implemented"));
    return true;
}

}  // namespace xiaozhi::mcp
