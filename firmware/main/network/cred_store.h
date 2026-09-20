#pragma once

// NVS 凭据存储:
//
// 1. 配网凭据 slatehub.net { ssid / pwd / url }: captive portal 提交后由 Save() 写入。
//
// 2. 内容服务端设备身份 slatehub.net { dev_id / dev_sec }:
//    register 响应里下发,SaveSecret() 单独写一次
//    并 commit,保证跨重启可见。后续所有受保护 API 用 Authorization: Bearer <device_secret>。
//    poll 收到 401 (secret 失效) 时调 ClearSecret() 让设备重启走 register 流,
//    不擦 wifi/server,体验上是"内部修复"而非"重新配网"。

#include <string>

namespace cred {

struct Credentials {
    std::string wifi_ssid;
    std::string wifi_pwd;
    std::string server_url;
    std::string device_id;
    std::string device_secret;
};

// Load 把 NVS 里所有字段读出来。返回 true 表示至少有 wifi_ssid + server_url (= 配网完整)。
// device_id/device_secret 可能为空 —— 表示首次启动或 self-reset 后,需要走 register。
bool Load(Credentials& out);

// 写配网凭据 (wifi + server_url)。captive portal submit 后调用。
// 不动 device_id/device_secret,保持身份与配网解耦。
bool Save(const Credentials& c);

// 独立 commit 设备身份。register 响应解析成功后立即调用一次。
// 半写保护:nvs_open RW → set 两个 key → commit → close,失败返回 false 由调用方决定 panic。
bool SaveSecret(const std::string& device_id, const std::string& device_secret);

// 清掉 device_id + device_secret,保留 wifi。下次启动会走 register 重新拿。
// 触发场景:poll 收到 401 (后端 reset 了我们 / DB 异常)。
void ClearSecret();

// 便利:从 NVS 读 server_url
std::string GetServerUrl();

// 工厂重置:清整个 namespace。下次启动进入配网模式。
void Clear();

}  // namespace cred
