#include "sync/manifest_contract.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace sync_contract {
namespace {

constexpr double kMaxExactJsonInteger = 9007199254740991.0;  // 2^53 - 1

std::string EscapeJsonString(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 8);
    for (unsigned char ch : value) {
        switch (ch) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\b':
                out += "\\b";
                break;
            case '\f':
                out += "\\f";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (ch < 0x20) {
                    static constexpr char kHex[] = "0123456789ABCDEF";
                    out += "\\u00";
                    out.push_back(kHex[ch >> 4]);
                    out.push_back(kHex[ch & 0x0F]);
                } else {
                    out.push_back(static_cast<char>(ch));
                }
                break;
        }
    }
    return out;
}

bool SameDescriptor(const display::FrameDescriptor& lhs, const display::FrameDescriptor& rhs) {
    return lhs.width == rhs.width && lhs.height == rhs.height && lhs.pixel_format == rhs.pixel_format &&
           lhs.codec == rhs.codec && lhs.byte_size == rhs.byte_size;
}

}  // namespace

const char* ApiPrefix() {
    return "/api/v2";
}

const char* PixelFormatWire(display::PixelFormat format) {
    switch (format) {
        case display::PixelFormat::kMono1:
            return "mono1";
        case display::PixelFormat::kGray2:
            return "gray2";
        case display::PixelFormat::kGray4:
            return "gray4";
        case display::PixelFormat::kTriColor:
            return "tri_color";
        case display::PixelFormat::kRgb565:
            return "rgb565";
    }
    return "";
}

const char* FrameCodecWire(display::FrameCodec codec) {
    switch (codec) {
        case display::FrameCodec::kRawMono1Msb:
            return "raw_mono1_msb";
    }
    return "";
}

bool ParsePixelFormat(const std::string& wire, display::PixelFormat& out) {
    if (wire == "mono1") {
        out = display::PixelFormat::kMono1;
        return true;
    }
    if (wire == "gray2") {
        out = display::PixelFormat::kGray2;
        return true;
    }
    if (wire == "gray4") {
        out = display::PixelFormat::kGray4;
        return true;
    }
    if (wire == "tri_color") {
        out = display::PixelFormat::kTriColor;
        return true;
    }
    if (wire == "rgb565") {
        out = display::PixelFormat::kRgb565;
        return true;
    }
    return false;
}

bool ParseFrameCodec(const std::string& wire, display::FrameCodec& out) {
    if (wire == "raw_mono1_msb") {
        out = display::FrameCodec::kRawMono1Msb;
        return true;
    }
    return false;
}

std::string BuildRegisterPayload(const std::string& mac, const display::DisplayInfo& display_info,
                                 const std::string& fw_version) {
    const char* board_id = display_info.board_id ? display_info.board_id : "";
    std::string body;
    body.reserve(mac.size() + std::strlen(board_id) + fw_version.size() + 72);
    body += "{\"mac\":\"";
    body += EscapeJsonString(mac);
    body += "\",\"board_id\":\"";
    body += EscapeJsonString(board_id);
    body += "\",\"protocol_version\":2,\"fw_version\":\"";
    body += EscapeJsonString(fw_version);
    body += "\"}";
    return body;
}

std::string ResolveFirmwareVersion(const char* app_version, const char* config_version) {
    if (app_version && app_version[0] != '\0')
        return app_version;
    if (config_version && config_version[0] != '\0')
        return config_version;
    return "unknown";
}

bool ReadIntField(NumericField field, int min_value, int max_value, int& out) {
    if (!field.present || !std::isfinite(field.value) || std::floor(field.value) != field.value ||
        field.value < static_cast<double>(min_value) || field.value > static_cast<double>(max_value)) {
        return false;
    }
    out = static_cast<int>(field.value);
    return true;
}

bool ReadSizeField(NumericField field, std::size_t max_value, std::size_t& out) {
    double bounded_max = static_cast<double>(max_value);
    if constexpr (std::numeric_limits<std::size_t>::digits > 53) {
        if (bounded_max > kMaxExactJsonInteger)
            bounded_max = kMaxExactJsonInteger;
    }
    if (!field.present || !std::isfinite(field.value) || std::floor(field.value) != field.value || field.value < 0.0 ||
        field.value > bounded_max) {
        return false;
    }
    out = static_cast<std::size_t>(field.value);
    return true;
}

bool ReadUint32Field(NumericField field, uint32_t& out) {
    std::size_t value = 0;
    if (!ReadSizeField(field, std::numeric_limits<uint32_t>::max(), value))
        return false;
    out = static_cast<uint32_t>(value);
    return true;
}

bool ReadOptionalStringField(const OptionalStringField& field, std::string& out) {
    if (!field.present || field.is_null) {
        out.clear();
        return true;
    }
    if (!field.is_string)
        return false;
    out = field.value;
    return true;
}

bool ReadAudioSizeField(const OptionalStringField& audio_etag, const OptionalNumberField& audio_size, int& out) {
    std::string etag;
    if (!ReadOptionalStringField(audio_etag, etag))
        return false;
    if (!audio_size.present || audio_size.is_null) {
        out = 0;
        return etag.empty();
    }
    return ReadIntField(audio_size.number, 0, std::numeric_limits<int>::max(), out);
}

bool ValidateOptionalObjectField(bool present, bool is_null, bool is_object) {
    return !present || is_null || is_object;
}

bool DescriptorMatchesDisplay(const std::string& profile_id, const display::FrameDescriptor& descriptor,
                              const display::DisplayInfo& display_info) {
    if (profile_id.empty() || profile_id != (display_info.profile_id ? display_info.profile_id : ""))
        return false;
    if (!display::ValidateFrameDescriptor(descriptor))
        return false;
    if (!display::ValidateFrameDescriptor(display_info.frame))
        return false;
    return SameDescriptor(descriptor, display_info.frame);
}

bool ValidateManifestIdentity(const ManifestIdentity& manifest, const display::DisplayInfo& display_info) {
    if (!DescriptorMatchesDisplay(manifest.display_profile_id, manifest.frame, display_info))
        return false;
    for (const ContentIdentity& content : manifest.contents) {
        if (!DescriptorMatchesDisplay(content.frame_profile_id, content.frame, display_info))
            return false;
        if (!SameDescriptor(content.frame, manifest.frame))
            return false;
    }
    return true;
}

bool ValidateManifestContentSet(const ManifestIdentity& manifest) {
    std::vector<int> seen;
    seen.reserve(manifest.contents.size());
    for (const ContentIdentity& content : manifest.contents) {
        if (content.seq < 0)
            return false;
        if (std::find(seen.begin(), seen.end(), content.seq) != seen.end())
            return false;
        seen.push_back(content.seq);
    }
    return true;
}

bool ValidateManifestEnvelope(const std::string& requested_group_id, const std::string& response_group_id,
                              const ManifestIdentity& manifest, const display::DisplayInfo& display_info) {
    return !requested_group_id.empty() && !response_group_id.empty() && requested_group_id == response_group_id &&
           ValidateManifestIdentity(manifest, display_info) && ValidateManifestContentSet(manifest);
}

bool ImagePayloadMatchesDescriptor(const std::vector<uint8_t>& bytes, const display::FrameDescriptor& descriptor) {
    return display::ValidateFrameDescriptor(descriptor) && bytes.size() == descriptor.byte_size;
}

bool ContentIsDownloadable(const ContentIdentity& content) {
    return !content.id.empty() && !content.image_etag.empty() && content.variant_status == "ready" &&
           content.image_size >= 0 && static_cast<std::size_t>(content.image_size) == content.frame.byte_size &&
           !content.frame_profile_id.empty() && display::ValidateFrameDescriptor(content.frame);
}

bool AudioAllowedForDisplay(const std::string& audio_etag, const display::DisplayInfo& display_info) {
    return !audio_etag.empty() && display_info.capabilities.audio;
}

CacheIdentity MakeCacheIdentity(const display::DisplayInfo& display_info) {
    return MakeCacheIdentity(display_info.profile_id ? display_info.profile_id : "", display_info.frame);
}

CacheIdentity MakeCacheIdentity(const std::string& profile_id, const display::FrameDescriptor& descriptor) {
    CacheIdentity identity;
    identity.profile_id   = profile_id;
    identity.width        = descriptor.width;
    identity.height       = descriptor.height;
    identity.pixel_format = descriptor.pixel_format;
    identity.frame_codec  = descriptor.codec;
    identity.byte_length  = descriptor.byte_size;
    return identity;
}

bool CacheIdentityMatches(const CacheIdentity& identity, const display::DisplayInfo& display_info) {
    return CacheIdentityMatches(identity, display_info.profile_id ? display_info.profile_id : "", display_info.frame);
}

bool CacheIdentityMatches(const CacheIdentity& identity, const std::string& profile_id,
                          const display::FrameDescriptor& descriptor) {
    return !identity.profile_id.empty() && identity.profile_id == profile_id && identity.width == descriptor.width &&
           identity.height == descriptor.height && identity.pixel_format == descriptor.pixel_format &&
           identity.frame_codec == descriptor.codec && identity.byte_length == descriptor.byte_size &&
           display::ValidateFrameDescriptor(descriptor);
}

bool CachedManifestCanUseEtag(const CacheIdentity& identity, const display::DisplayInfo& display_info,
                              const std::string& cached_etag, const std::string& expected_etag) {
    return !cached_etag.empty() && cached_etag == expected_etag && CacheIdentityMatches(identity, display_info);
}

bool SanitizeAudioForDisplay(ContentIdentity& content, const display::DisplayInfo& display_info) {
    if (!DescriptorMatchesDisplay(content.frame_profile_id, content.frame, display_info))
        return false;
    if (!AudioAllowedForDisplay(content.audio_etag, display_info))
        content.audio_etag.clear();
    return true;
}

}  // namespace sync_contract
