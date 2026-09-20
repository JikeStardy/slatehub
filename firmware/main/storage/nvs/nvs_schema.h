#pragma once

#include <cstddef>

#include <nvs.h>

namespace nvs_schema {

template <std::size_t N>
constexpr bool FitsName(const char (&)[N]) {
    return N > 1 && N <= NVS_KEY_NAME_MAX_SIZE;
}

template <std::size_t A, std::size_t B>
constexpr bool SameName(const char (&a)[A], const char (&b)[B]) {
    if constexpr (A != B) {
        return false;
    }
    for (std::size_t i = 0; i < A; ++i) {
        if (a[i] != b[i])
            return false;
    }
    return true;
}

inline constexpr char kNet[]         = "slatehub.net";
inline constexpr char kAudio[]       = "slatehub.audio";
inline constexpr char kXiaozhi[]     = "slatehub.xiao";
inline constexpr char kXiaozhiMqtt[] = "slatehub.x.mq";
inline constexpr char kXiaozhiWs[]   = "slatehub.x.ws";

namespace net {
inline constexpr char kSsid[]   = "ssid";
inline constexpr char kPwd[]    = "pwd";
inline constexpr char kUrl[]    = "url";
inline constexpr char kDevId[]  = "dev_id";
inline constexpr char kDevSec[] = "dev_sec";
}  // namespace net

namespace audio {
inline constexpr char kVolume[] = "volume";
}  // namespace audio

namespace xiaozhi {
inline constexpr char kUuid[] = "uuid";
}  // namespace xiaozhi

namespace mqtt {
inline constexpr char kEndpoint[]  = "endpoint";
inline constexpr char kClientId[]  = "client_id";
inline constexpr char kUsername[]  = "username";
inline constexpr char kPassword[]  = "password";
inline constexpr char kPubTopic[]  = "pub_topic";
inline constexpr char kKeepalive[] = "keepalive";
}  // namespace mqtt

namespace ws {
inline constexpr char kUrl[]     = "url";
inline constexpr char kToken[]   = "token";
inline constexpr char kVersion[] = "version";
}  // namespace ws

#define SLATEHUB_NVS_ASSERT_NAME(name) static_assert(::nvs_schema::FitsName(name), #name " exceeds NVS name limit")

SLATEHUB_NVS_ASSERT_NAME(kNet);
SLATEHUB_NVS_ASSERT_NAME(kAudio);
SLATEHUB_NVS_ASSERT_NAME(kXiaozhi);
SLATEHUB_NVS_ASSERT_NAME(kXiaozhiMqtt);
SLATEHUB_NVS_ASSERT_NAME(kXiaozhiWs);

static_assert(!SameName(kNet, kAudio), "NVS namespaces must be unique");
static_assert(!SameName(kNet, kXiaozhi), "NVS namespaces must be unique");
static_assert(!SameName(kNet, kXiaozhiMqtt), "NVS namespaces must be unique");
static_assert(!SameName(kNet, kXiaozhiWs), "NVS namespaces must be unique");
static_assert(!SameName(kAudio, kXiaozhi), "NVS namespaces must be unique");
static_assert(!SameName(kAudio, kXiaozhiMqtt), "NVS namespaces must be unique");
static_assert(!SameName(kAudio, kXiaozhiWs), "NVS namespaces must be unique");
static_assert(!SameName(kXiaozhi, kXiaozhiMqtt), "NVS namespaces must be unique");
static_assert(!SameName(kXiaozhi, kXiaozhiWs), "NVS namespaces must be unique");
static_assert(!SameName(kXiaozhiMqtt, kXiaozhiWs), "NVS namespaces must be unique");

SLATEHUB_NVS_ASSERT_NAME(net::kSsid);
SLATEHUB_NVS_ASSERT_NAME(net::kPwd);
SLATEHUB_NVS_ASSERT_NAME(net::kUrl);
SLATEHUB_NVS_ASSERT_NAME(net::kDevId);
SLATEHUB_NVS_ASSERT_NAME(net::kDevSec);

SLATEHUB_NVS_ASSERT_NAME(audio::kVolume);

SLATEHUB_NVS_ASSERT_NAME(xiaozhi::kUuid);

SLATEHUB_NVS_ASSERT_NAME(mqtt::kEndpoint);
SLATEHUB_NVS_ASSERT_NAME(mqtt::kClientId);
SLATEHUB_NVS_ASSERT_NAME(mqtt::kUsername);
SLATEHUB_NVS_ASSERT_NAME(mqtt::kPassword);
SLATEHUB_NVS_ASSERT_NAME(mqtt::kPubTopic);
SLATEHUB_NVS_ASSERT_NAME(mqtt::kKeepalive);

SLATEHUB_NVS_ASSERT_NAME(ws::kUrl);
SLATEHUB_NVS_ASSERT_NAME(ws::kToken);
SLATEHUB_NVS_ASSERT_NAME(ws::kVersion);

#undef SLATEHUB_NVS_ASSERT_NAME

}  // namespace nvs_schema
