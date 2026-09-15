#pragma once

#include <esp_err.h>
#include <esp_http_client.h>

#include <string>

namespace xiaozhi {

struct ActivationConfigResult {
    bool        ok                       = false;
    bool        has_activation           = false;
    bool        has_activation_challenge = false;
    bool        has_protocol             = false;
    bool        server_time_synced       = false;
    int         activation_timeout_ms    = 30000;
    int         http_status              = 0;
    std::string activation_message;
    std::string activation_code;
    std::string activation_challenge;
    std::string error;
};

class ActivationClient {
   public:
    static constexpr const char* kConfigUrl = "https://api.tenclass.net/xiaozhi/ota/";
    static constexpr const char* kLanguage  = "zh-CN";

    ActivationConfigResult Fetch();
    esp_err_t              Activate(const std::string& challenge);
    std::string            DeviceId() const;

   private:
    std::string UserAgent() const;
    std::string SystemInfoJson() const;
    std::string SerialNumber() const;
    void SetupHeaders(esp_http_client_handle_t client, const std::string& device_id, const std::string& client_id,
                      const std::string& user_agent, const std::string& serial_number) const;
    std::string ActivationPayload(const std::string& challenge, const std::string& serial_number) const;
};

}  // namespace xiaozhi
