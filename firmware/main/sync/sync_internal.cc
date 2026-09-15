#include "sync/sync_internal.h"

namespace sync_internal {

std::string ExistingImageEtag(const std::string& gid, int seq, const std::string& expected_etag,
                              const display::DisplayInfo& display_info) {
    cache::FrameMeta meta;
    if (cache::ReadFrameMeta(gid, seq, meta) && cache::FrameImageExists(gid, seq, meta.image_etag, display_info)) {
        return meta.image_etag;
    }
    if (cache::FrameImageExists(gid, seq, expected_etag, display_info)) {
        return expected_etag;
    }
    return "";
}

std::string ExistingAudioEtag(const std::string& gid, int seq, const std::string& expected_etag,
                              const display::DisplayInfo& display_info) {
    cache::FrameMeta meta;
    if (cache::ReadFrameMeta(gid, seq, meta) && !meta.audio_etag.empty() &&
        cache::FrameAudioExists(gid, seq, meta.audio_etag, display_info)) {
        return meta.audio_etag;
    }
    if (cache::FrameAudioExists(gid, seq, expected_etag, display_info)) {
        return expected_etag;
    }
    return "";
}

uint8_t ClampProgressCount(int value) {
    if (value < 0)
        return 0;
    return static_cast<uint8_t>(value > 255 ? 255 : value);
}

}  // namespace sync_internal
