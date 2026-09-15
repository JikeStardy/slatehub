#pragma once

#include <cstddef>
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

const char* ApiPrefix();
const char* PixelFormatWire(display::PixelFormat format);
const char* FrameCodecWire(display::FrameCodec codec);
bool        ParsePixelFormat(const std::string& wire, display::PixelFormat& out);
bool        ParseFrameCodec(const std::string& wire, display::FrameCodec& out);

std::string BuildRegisterPayload(const std::string& mac, const display::DisplayInfo& display_info,
                                 const std::string& fw_version);

bool DescriptorMatchesDisplay(const std::string& profile_id, const display::FrameDescriptor& descriptor,
                              const display::DisplayInfo& display_info);
bool ValidateManifestIdentity(const ManifestIdentity& manifest, const display::DisplayInfo& display_info);
bool ImagePayloadMatchesDescriptor(const std::vector<uint8_t>& bytes, const display::FrameDescriptor& descriptor);
bool ContentIsDownloadable(const ContentIdentity& content);

CacheIdentity MakeCacheIdentity(const display::DisplayInfo& display_info);
CacheIdentity MakeCacheIdentity(const std::string& profile_id, const display::FrameDescriptor& descriptor);
bool          CacheIdentityMatches(const CacheIdentity& identity, const display::DisplayInfo& display_info);
bool          CacheIdentityMatches(const CacheIdentity& identity, const std::string& profile_id,
                                   const display::FrameDescriptor& descriptor);
bool          CachedManifestCanUseEtag(const CacheIdentity& identity, const display::DisplayInfo& display_info,
                                       const std::string& cached_etag, const std::string& expected_etag);

bool SanitizeAudioForDisplay(ContentIdentity& content, const display::DisplayInfo& display_info);

}  // namespace sync_contract
