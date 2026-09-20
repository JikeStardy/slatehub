#include "update/firmware_offer.h"

#include <cJSON.h>

#include <cmath>
#include <cstring>
#include <limits>
#include <utility>

#ifndef SLATEHUB_BOARD_ID
#error "SLATEHUB_BOARD_ID must be defined by the board build"
#endif

namespace firmware_update {
namespace {

const cJSON* ObjectItem(const cJSON* object, const char* key) {
    return cJSON_GetObjectItemCaseSensitive(object, key);
}

std::string JsonString(const cJSON* object, const char* key) {
    const cJSON* item = ObjectItem(object, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}

bool HasInvalidFields(const cJSON* object, const char* const* allowed, size_t allowed_count) {
    if (!cJSON_IsObject(object))
        return true;
    for (const cJSON* child = object->child; child; child = child->next) {
        bool known = false;
        for (size_t i = 0; i < allowed_count; ++i) {
            if (child->string && std::strcmp(child->string, allowed[i]) == 0) {
                known = true;
                break;
            }
        }
        if (!known)
            return true;
    }
    for (size_t i = 0; i < allowed_count; ++i) {
        size_t occurrences = 0;
        for (const cJSON* child = object->child; child; child = child->next) {
            if (child->string && std::strcmp(child->string, allowed[i]) == 0)
                ++occurrences;
        }
        if (occurrences != 1)
            return true;
    }
    return false;
}

bool IsSemanticVersion(const std::string& value) {
    constexpr size_t kMaxVersionLength = 63;
    if (value.empty() || value.size() > kMaxVersionLength)
        return false;

    int  dots          = 0;
    bool segment_empty = true;
    for (char ch : value) {
        if (ch >= '0' && ch <= '9') {
            segment_empty = false;
            continue;
        }
        if (ch != '.' || segment_empty || ++dots > 2)
            return false;
        segment_empty = true;
    }
    return dots == 2 && !segment_empty;
}

bool IsLowerHexSha256(const std::string& value) {
    if (value.size() != 64)
        return false;
    for (char ch : value) {
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')))
            return false;
    }
    return true;
}

bool StartsWith(const std::string& value, const char* prefix) {
    const size_t len = std::strlen(prefix);
    return value.size() >= len && value.compare(0, len, prefix) == 0;
}

bool IsAsciiHostname(const std::string& value) {
    if (value.empty() || value.front() == '.' || value.back() == '.')
        return false;
    bool previous_dot = false;
    for (char ch : value) {
        const bool is_alnum = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                              (ch >= '0' && ch <= '9');
        if (!is_alnum && ch != '-' && ch != '.')
            return false;
        if (ch == '.' && previous_dot)
            return false;
        previous_dot = ch == '.';
    }
    return true;
}

bool IsValidAuthority(const std::string& authority) {
    if (authority.empty() || authority.find('@') != std::string::npos)
        return false;

    const size_t colon = authority.rfind(':');
    if (colon == std::string::npos)
        return IsAsciiHostname(authority);
    if (authority.find(':') != colon || !IsAsciiHostname(authority.substr(0, colon)))
        return false;

    const std::string port = authority.substr(colon + 1);
    if (port.empty())
        return false;
    unsigned value = 0;
    for (char ch : port) {
        if (ch < '0' || ch > '9')
            return false;
        const unsigned digit = static_cast<unsigned>(ch - '0');
        if (value > (65535U - digit) / 10U)
            return false;
        value = value * 10U + digit;
    }
    return true;
}

bool IsHttpsUrl(const std::string& value) {
    if (!StartsWith(value, "https://"))
        return false;
    for (unsigned char ch : value) {
        if (ch <= 0x20U || ch == 0x7FU)
            return false;
    }
    const size_t authority_start = std::strlen("https://");
    const size_t authority_end   = value.find_first_of("/?#", authority_start);
    const size_t authority_size  = (authority_end == std::string::npos ? value.size() : authority_end) -
                                  authority_start;
    return IsValidAuthority(value.substr(authority_start, authority_size));
}

std::string UrlBasename(std::string url) {
    const size_t query_pos = url.find_first_of("?#");
    if (query_pos != std::string::npos)
        url.resize(query_pos);
    const size_t slash_pos = url.find_last_of('/');
    return slash_pos == std::string::npos ? url : url.substr(slash_pos + 1);
}

FirmwareOfferResult Reject(const char* reason) {
    FirmwareOfferResult result;
    result.reject_reason = reason;
    return result;
}

bool HasForbiddenNullEncoding(std::string_view json) {
    return json.find('\0') != std::string_view::npos || json.find("\\u0000") != std::string_view::npos;
}

bool ReadSize(const cJSON* object, std::size_t* out) {
    const cJSON* size_item = ObjectItem(object, "size_bytes");
    if (!cJSON_IsNumber(size_item) || size_item->valuedouble <= 0)
        return false;
    if (!std::isfinite(size_item->valuedouble))
        return false;
    if (std::floor(size_item->valuedouble) != size_item->valuedouble)
        return false;
    constexpr double kMaxSafeJsonInteger = 9007199254740991.0;
    if (size_item->valuedouble > kMaxSafeJsonInteger)
        return false;
    const double max_size = static_cast<double>(std::numeric_limits<std::size_t>::max());
    if (size_item->valuedouble > max_size)
        return false;
    *out = static_cast<std::size_t>(size_item->valuedouble);
    return *out > 0;
}

}  // namespace

FirmwareOfferResult ReadFirmwareOffer(std::string_view metadata_json) {
    if (metadata_json.empty() || HasForbiddenNullEncoding(metadata_json))
        return Reject("metadata_invalid");

    const std::string owned_json(metadata_json);
    const char*       parse_end = nullptr;
    std::unique_ptr<cJSON, decltype(&cJSON_Delete)> root(
        cJSON_ParseWithOpts(owned_json.c_str(), &parse_end, true), cJSON_Delete);
    if (!root || parse_end != owned_json.c_str() + owned_json.size())
        return Reject("metadata_invalid");
    if (!cJSON_IsObject(root.get()))
        return Reject("metadata_invalid");
    const cJSON* firmware = root.get();
    static constexpr const char* kFirmwareFields[] = {
        "schema_version", "product", "board_id", "version", "release_tag", "artifact"};
    if (HasInvalidFields(firmware, kFirmwareFields, sizeof(kFirmwareFields) / sizeof(kFirmwareFields[0])))
        return Reject("metadata_fields_invalid");

    const cJSON* schema_version = ObjectItem(firmware, "schema_version");
    if (!cJSON_IsNumber(schema_version) || schema_version->valuedouble != 1.0)
        return Reject("schema_version_invalid");
    if (JsonString(firmware, "product") != "slatehub")
        return Reject("product_invalid");

    const cJSON* artifact = ObjectItem(firmware, "artifact");
    if (!cJSON_IsObject(artifact))
        return Reject("artifact_missing");
    static constexpr const char* kArtifactFields[] = {"kind", "filename", "size_bytes", "sha256", "download_url"};
    if (HasInvalidFields(artifact, kArtifactFields, sizeof(kArtifactFields) / sizeof(kArtifactFields[0])))
        return Reject("artifact_fields_invalid");
    if (JsonString(artifact, "kind") != "ota")
        return Reject("artifact_kind_invalid");

    std::unique_ptr<AcceptedFirmwareOffer> offer(new AcceptedFirmwareOffer());
    offer->board_id_ = JsonString(firmware, "board_id");
    if (offer->board_id_ != SLATEHUB_BOARD_ID)
        return Reject("board_id_mismatch");
    offer->version_ = JsonString(firmware, "version");
    if (offer->version_.empty())
        return Reject("version_missing");
    if (!IsSemanticVersion(offer->version_))
        return Reject("version_invalid");
    offer->release_tag_ = JsonString(firmware, "release_tag");
    if (offer->release_tag_.empty())
        return Reject("release_tag_missing");
    if (offer->release_tag_ != "v" + offer->version_)
        return Reject("release_tag_invalid");
    offer->filename_ = JsonString(artifact, "filename");
    if (offer->filename_.empty())
        return Reject("filename_missing");
    const std::string expected_filename =
        "slatehub-" + offer->board_id_ + "-" + offer->release_tag_ + "-ota.bin";
    if (offer->filename_ != expected_filename)
        return Reject("filename_invalid");
    offer->download_url_ = JsonString(artifact, "download_url");
    if (!IsHttpsUrl(offer->download_url_))
        return Reject("url_not_https");
    if (UrlBasename(offer->download_url_) != offer->filename_)
        return Reject("filename_url_basename_mismatch");
    if (!ReadSize(artifact, &offer->size_bytes_))
        return Reject("size_invalid");
    offer->sha256_ = JsonString(artifact, "sha256");
    if (!IsLowerHexSha256(offer->sha256_))
        return Reject("sha256_invalid");

    FirmwareOfferResult result;
    result.accepted = true;
    result.offer    = std::move(offer);
    return result;
}

}  // namespace firmware_update
