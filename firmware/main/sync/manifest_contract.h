#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "drivers/display/display_contract.h"

namespace sync_contract {

struct ContentIdentity {
    int                      seq = 0;
    std::string              id;
    std::string              image_etag;
    std::string              audio_etag;
    std::string              variant_status;
    int                      image_size = 0;
    std::string              frame_profile_id;
    display::FrameDescriptor frame{};
};

struct ManifestIdentity {
    std::string                      display_profile_id;
    display::FrameDescriptor         frame{};
    std::vector<ContentIdentity>     contents;
};

struct CacheIdentity {
    std::string         profile_id;
    int                 width = 0;
    int                 height = 0;
    display::PixelFormat pixel_format = display::PixelFormat::kMono1;
    display::FrameCodec  frame_codec = display::FrameCodec::kRawMono1Msb;
    std::size_t         byte_length = 0;
};

struct NumericField {
    bool   present = false;
    double value   = 0.0;
};

struct OptionalStringField {
    bool        present = false;
    bool        is_null = false;
    bool        is_string = false;
    std::string value;
};

struct OptionalNumberField {
    bool         present = false;
    bool         is_null = false;
    NumericField number;
};

const char* ApiPrefix();
const char* PixelFormatWire(display::PixelFormat format);
const char* FrameCodecWire(display::FrameCodec codec);
bool        ParsePixelFormat(const std::string& wire, display::PixelFormat& out);
bool        ParseFrameCodec(const std::string& wire, display::FrameCodec& out);

std::string BuildRegisterPayload(const std::string& mac, const display::DisplayInfo& display_info,
                                 const std::string& fw_version);
std::string ResolveFirmwareVersion(const char* app_version, const char* config_version);

bool ReadIntField(NumericField field, int min_value, int max_value, int& out);
bool ReadSizeField(NumericField field, std::size_t max_value, std::size_t& out);
bool ReadUint32Field(NumericField field, uint32_t& out);
bool ReadOptionalStringField(const OptionalStringField& field, std::string& out);
bool ReadAudioSizeField(const OptionalStringField& audio_etag, const OptionalNumberField& audio_size, int& out);
bool ValidateOptionalObjectField(bool present, bool is_null, bool is_object);

bool DescriptorMatchesDisplay(const std::string& profile_id, const display::FrameDescriptor& descriptor,
                              const display::DisplayInfo& display_info);
bool ValidateManifestIdentity(const ManifestIdentity& manifest, const display::DisplayInfo& display_info);
bool ValidateManifestContentSet(const ManifestIdentity& manifest);
bool ValidateManifestEnvelope(const std::string& requested_group_id, const std::string& response_group_id,
                              const ManifestIdentity& manifest, const display::DisplayInfo& display_info);
bool ImagePayloadMatchesDescriptor(const std::vector<uint8_t>& bytes, const display::FrameDescriptor& descriptor);
bool ContentIsDownloadable(const ContentIdentity& content);
bool AudioAllowedForDisplay(const std::string& audio_etag, const display::DisplayInfo& display_info);

CacheIdentity MakeCacheIdentity(const display::DisplayInfo& display_info);
CacheIdentity MakeCacheIdentity(const std::string& profile_id, const display::FrameDescriptor& descriptor);
bool          CacheIdentityMatches(const CacheIdentity& identity, const display::DisplayInfo& display_info);
bool          CacheIdentityMatches(const CacheIdentity& identity, const std::string& profile_id,
                                   const display::FrameDescriptor& descriptor);
bool          CachedManifestCanUseEtag(const CacheIdentity& identity, const display::DisplayInfo& display_info,
                                       const std::string& cached_etag, const std::string& expected_etag);

bool SanitizeAudioForDisplay(ContentIdentity& content, const display::DisplayInfo& display_info);

}  // namespace sync_contract
