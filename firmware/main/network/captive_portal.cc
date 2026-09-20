#include "network/captive_portal.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_wifi.h>
#include <lwip/inet.h>
#include <sdkconfig.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "network/wifi.h"
#include "resources/captive_portal_html.h"
#include "utils/json_utils.h"

namespace {
constexpr char   kTag[]           = "portal";
constexpr size_t kMaxServerUrlLen = 256;
std::mutex       g_scan_mutex;

std::string WifiSsidToString(const uint8_t ssid[32]) {
    size_t len = 0;
    while (len < 32 && ssid[len] != 0)
        ++len;
    return std::string(reinterpret_cast<const char*>(ssid), len);
}

CaptivePortal* PortalFromRequest(httpd_req_t* req) {
    return req ? static_cast<CaptivePortal*>(req->user_ctx) : nullptr;
}

bool ValidServerUrl(const std::string& url, std::string& error) {
    if (url.empty()) {
        error = "服务端 URL 不能为空";
        return false;
    }
    if (url.size() > kMaxServerUrlLen) {
        error = "服务端 URL 过长";
        return false;
    }
    for (unsigned char ch : url) {
        if (ch <= 0x20 || ch == 0x7F) {
            error = "服务端 URL 含非法字符";
            return false;
        }
    }
    if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) {
        error = "服务端 URL 需以 http:// 或 https:// 开头";
        return false;
    }
    return true;
}

struct FinishTaskContext {
    std::shared_ptr<std::atomic<bool>> alive;
    CaptivePortal::FinishedCb          on_finished;
};

struct StopTaskContext {
    std::shared_ptr<std::atomic<bool>> alive;
    CaptivePortal*                     portal = nullptr;
};

}  // namespace

static std::string EscapeHtmlAttr(const std::string& value) {
    std::string out;
    out.reserve(value.size());
    for (char ch : value) {
        switch (ch) {
            case '&':
                out += "&amp;";
                break;
            case '<':
                out += "&lt;";
                break;
            case '>':
                out += "&gt;";
                break;
            case '"':
                out += "&quot;";
                break;
            case '\'':
                out += "&#39;";
                break;
            default:
                out.push_back(ch);
                break;
        }
    }
    return out;
}

static std::string RenderTemplate(const std::string&                                      tmpl,
                                  const std::vector<std::pair<std::string, std::string>>& vars) {
    std::string s = tmpl;
    for (const auto& p : vars) {
        const std::string token = "{{" + p.first + "}}";
        size_t            pos   = 0;
        const std::string value = EscapeHtmlAttr(p.second);
        while ((pos = s.find(token, pos)) != std::string::npos) {
            s.replace(pos, token.size(), value);
            pos += value.size();
        }
    }
    return s;
}

// ─── HTTP handlers ─────────────────────────────────────────────────
esp_err_t CaptivePortal::HandleRoot(httpd_req_t* req) {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ap_ssid[24];
    std::snprintf(ap_ssid, sizeof(ap_ssid), "%s-%02X%02X", CONFIG_SLATEHUB_AP_SSID_PREFIX, mac[4], mac[5]);

    std::string html =
        RenderTemplate(slatehub::kCaptivePortalHtml, {
                                                         {"SERVER_URL", CONFIG_SLATEHUB_DEFAULT_SERVER_URL},
                                                         {"AP_SSID", ap_ssid},
                                                     });
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, html.c_str(), html.size());
}

esp_err_t CaptivePortal::HandleScan(httpd_req_t* req) {
    std::unique_lock<std::mutex> scan_lock(g_scan_mutex, std::try_to_lock);
    if (!scan_lock.owns_lock()) {
        httpd_resp_set_status(req, "429 Too Many Requests");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, R"({"error":"scan in progress"})", -1);
        return ESP_OK;
    }

    wifi_scan_config_t scan_cfg   = {};
    scan_cfg.show_hidden          = false;
    scan_cfg.scan_type            = WIFI_SCAN_TYPE_ACTIVE;
    scan_cfg.scan_time.active.min = 30;
    scan_cfg.scan_time.active.max = 90;
    esp_err_t err                 = esp_wifi_scan_start(&scan_cfg, true);  // blocking
    uint16_t  num                 = 0;
    if (err == ESP_OK) {
        esp_wifi_scan_get_ap_num(&num);
    } else {
        ESP_LOGW(kTag, "wifi scan failed err=%s", esp_err_to_name(err));
    }
    std::vector<wifi_ap_record_t> recs(num);
    if (num > 0) {
        esp_wifi_scan_get_ap_records(&num, recs.data());
    }

    cJSON* arr = cJSON_CreateArray();
    if (!arr) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, "[]", -1);
        return ESP_OK;
    }
    for (auto& r : recs) {
        cJSON* item = cJSON_CreateObject();
        if (!item)
            continue;
        const std::string ssid = WifiSsidToString(r.ssid);
        cJSON_AddStringToObject(item, "ssid", ssid.c_str());
        cJSON_AddNumberToObject(item, "rssi", r.rssi);
        cJSON_AddNumberToObject(item, "authmode", r.authmode);
        cJSON_AddItemToArray(arr, item);
    }
    char* out = cJSON_PrintUnformatted(arr);
    httpd_resp_set_type(req, "application/json");
    if (out) {
        httpd_resp_send(req, out, std::strlen(out));
    } else {
        httpd_resp_send(req, "[]", -1);
    }
    cJSON_free(out);
    cJSON_Delete(arr);
    return ESP_OK;
}

esp_err_t CaptivePortal::HandleSubmit(httpd_req_t* req) {
    CaptivePortal* portal = PortalFromRequest(req);
    if (req->content_len > 1024) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body too large");
        return ESP_FAIL;
    }
    char buf[1024 + 1] = {0};
    int  total         = 0;
    while (total < req->content_len) {
        int r = httpd_req_recv(req, buf + total, req->content_len - total);
        if (r <= 0) {
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "recv failed");
            return ESP_FAIL;
        }
        total += r;
    }
    cJSON* root = cJSON_Parse(buf);
    if (!root) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, R"({"success":false,"error":"invalid json"})", -1);
        return ESP_OK;
    }

    auto get = [&](const char* k) -> std::string {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(root, k);
        if (cJSON_IsString(v) && v->valuestring)
            return v->valuestring;
        return "";
    };

    Submission sub;
    sub.ssid       = get("ssid");
    sub.password   = get("password");
    sub.server_url = get("server_url");
    cJSON_Delete(root);

    if (sub.ssid.empty() || sub.server_url.empty()) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, R"({"success":false,"error":"missing fields"})", -1);
        return ESP_OK;
    }
    std::string validation_error;
    if (!ValidServerUrl(sub.server_url, validation_error)) {
        std::string body = "{\"success\":false,\"error\":" + json_utils::JsonStringLiteral(validation_error) + "}";
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, body.c_str(), body.size());
        return ESP_OK;
    }

    bool        ok = false;
    std::string err_msg;
    if (portal && portal->on_submit_) {
        ok = portal->on_submit_(sub, err_msg);
    } else {
        err_msg = "internal: no submit handler";
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Connection", "close");
    if (ok) {
        httpd_resp_send(req, R"({"success":true})", -1);
        // 启异步 task：延迟 2 s 让浏览器收到 success 渲染 UI，然后通知上层
        // （App::OnFinished 内部 portal.Stop + esp_restart）。
        // 栈 8 KB：Stop 调链含 httpd_stop + esp_wifi_stop + esp_netif_destroy，
        // 以及 esp_restart，4 KB 偏紧。
        if (portal && portal->on_finished_) {
            auto* ctx = new (std::nothrow) FinishTaskContext{portal->alive_, portal->on_finished_};
            if (!ctx) {
                ESP_LOGE(kTag, "finish context alloc failed action=inline");
                portal->on_finished_(true);
                return ESP_OK;
            }
            BaseType_t r = xTaskCreate(&CaptivePortal::FinishTask, "portal_done", 8 * 1024, ctx, 3, nullptr);
            if (r != pdPASS) {
                delete ctx;
                // 创建失败(堆紧张):同步触发 finished,避免 AP 永远不关。
                // 缺点是浏览器看不到 success 页(连接随即断),但比 AP 一直开着好。
                ESP_LOGE(kTag, "finish task create failed action=inline");
                portal->on_finished_(true);
            }
        }
    } else {
        // 表单失败:回 {success:false, error:中文文案}。
        std::string body = "{\"success\":false,\"error\":" + json_utils::JsonStringLiteral(err_msg) + "}";
        httpd_resp_send(req, body.c_str(), body.size());
    }
    return ESP_OK;
}

esp_err_t CaptivePortal::HandleDone(httpd_req_t* req) {
    httpd_resp_set_type(req, "text/plain; charset=utf-8");
    httpd_resp_send(req, "Connected. You can close this page.", -1);
    return ESP_OK;
}

esp_err_t CaptivePortal::HandleExit(httpd_req_t* req) {
    httpd_resp_send(req, "ok", -1);
    CaptivePortal* portal = PortalFromRequest(req);
    if (portal) {
        auto* ctx = new (std::nothrow) StopTaskContext{portal->alive_, portal};
        if (!ctx) {
            ESP_LOGE(kTag, "exit context alloc failed");
            return ESP_OK;
        }
        BaseType_t r = xTaskCreate(&CaptivePortal::StopTask, "portal_exit", 8 * 1024, ctx, 3, nullptr);
        if (r != pdPASS) {
            delete ctx;
            ESP_LOGE(kTag, "exit task create failed");
        }
    }
    return ESP_OK;
}

esp_err_t CaptivePortal::HandleCatchAll(httpd_req_t* req) {
    // captive portal:把任何未知 URL 重定向到根
    CaptivePortal* portal = PortalFromRequest(req);
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", portal ? portal->ap_url_.c_str() : "http://192.168.4.1/");
    httpd_resp_send(req, nullptr, 0);
    return ESP_OK;
}

// ─── lifecycle ─────────────────────────────────────────────────────
CaptivePortal::~CaptivePortal() {
    alive_->store(false, std::memory_order_release);
    Stop();
}

bool CaptivePortal::Start() {
    if (running_.load())
        return true;

    if (!Wifi::Get().StartAp(CONFIG_SLATEHUB_AP_SSID_PREFIX)) {
        ESP_LOGE(kTag, "start failed reason=start_ap_failed");
        return false;
    }

    // 配 DHCP server 主动推送 "DNS = AP IP",让客户端把 DNS 查询发到我们这。
    // 默认 dhcps 不发 DNS option,客户端会用之前 4G/家 wifi 配的 DNS,
    // captive portal 探测就不会命中我们 → 不弹页。
    esp_netif_t* ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (ap_netif) {
        esp_netif_ip_info_t ip_info = {};
        esp_netif_get_ip_info(ap_netif, &ip_info);
        char ap_url[32];
        std::snprintf(ap_url, sizeof(ap_url), "http://" IPSTR "/", IP2STR(&ip_info.ip));
        ap_url_ = ap_url;

        esp_netif_dns_info_t dns = {};
        dns.ip.u_addr.ip4.addr   = ip_info.ip.addr;
        dns.ip.type              = ESP_IPADDR_TYPE_V4;
        esp_netif_dhcps_stop(ap_netif);
        // option 6 = DNS server
        uint8_t opt = 1;
        esp_netif_dhcps_option(ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &opt, sizeof(opt));
        esp_netif_set_dns_info(ap_netif, ESP_NETIF_DNS_MAIN, &dns);
        esp_netif_dhcps_start(ap_netif);

        // DNS 劫持服务:把所有查询响应到 AP IP
        dns_.Start(ip_info.ip);
    } else {
        ESP_LOGW(kTag, "dns hijack skipped reason=ap_netif_missing");
    }

    httpd_config_t cfg   = HTTPD_DEFAULT_CONFIG();
    cfg.max_uri_handlers = 8;
    cfg.uri_match_fn     = httpd_uri_match_wildcard;
    // 默认 4 KB 栈不够：HandleSubmit 里调 Wifi::TryConnect（阻塞等 event）
    // + ESP_LOG（vfprintf 含 UTF-8 中文消耗大），会触发 LoadProhibited panic。
    cfg.stack_size = 8192;
    if (httpd_start(&server_, &cfg) != ESP_OK) {
        ESP_LOGE(kTag, "start failed reason=http_server_start_failed");
        dns_.Stop();
        Wifi::Get().StopAp();
        return false;
    }

    httpd_uri_t uri_root   = {.uri = "/", .method = HTTP_GET, .handler = &HandleRoot, .user_ctx = this};
    httpd_uri_t uri_scan   = {.uri = "/scan", .method = HTTP_GET, .handler = &HandleScan, .user_ctx = this};
    httpd_uri_t uri_submit = {.uri = "/submit", .method = HTTP_POST, .handler = &HandleSubmit, .user_ctx = this};
    httpd_uri_t uri_done   = {.uri = "/done", .method = HTTP_GET, .handler = &HandleDone, .user_ctx = this};
    httpd_uri_t uri_exit   = {.uri = "/exit", .method = HTTP_POST, .handler = &HandleExit, .user_ctx = this};
    httpd_uri_t uri_catch  = {.uri = "/*", .method = HTTP_GET, .handler = &HandleCatchAll, .user_ctx = this};

    httpd_register_uri_handler(server_, &uri_root);
    httpd_register_uri_handler(server_, &uri_scan);
    httpd_register_uri_handler(server_, &uri_submit);
    httpd_register_uri_handler(server_, &uri_done);
    httpd_register_uri_handler(server_, &uri_exit);
    httpd_register_uri_handler(server_, &uri_catch);

    running_.store(true);
    return true;
}

void CaptivePortal::Stop() {
    if (!running_.load())
        return;
    dns_.Stop();
    if (server_) {
        httpd_stop(server_);
        server_ = nullptr;
    }
    Wifi::Get().StopAp();
    running_.store(false);
}

void CaptivePortal::OnSubmit(SubmitCb cb) {
    on_submit_ = std::move(cb);
}

void CaptivePortal::OnFinished(FinishedCb cb) {
    on_finished_ = std::move(cb);
}

void CaptivePortal::FinishTask(void* arg) {
    std::unique_ptr<FinishTaskContext> ctx(static_cast<FinishTaskContext*>(arg));
    vTaskDelay(pdMS_TO_TICKS(2000));
    if (ctx && ctx->alive && ctx->alive->load(std::memory_order_acquire) && ctx->on_finished) {
        ctx->on_finished(true);
    }
    vTaskDelete(nullptr);
}

void CaptivePortal::StopTask(void* arg) {
    std::unique_ptr<StopTaskContext> ctx(static_cast<StopTaskContext*>(arg));
    vTaskDelay(pdMS_TO_TICKS(100));
    if (ctx && ctx->alive && ctx->alive->load(std::memory_order_acquire) && ctx->portal)
        ctx->portal->Stop();
    vTaskDelete(nullptr);
}
