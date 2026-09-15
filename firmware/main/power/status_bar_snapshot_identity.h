#pragma once

#include <cstddef>
#include <cstdint>

#include "drivers/display/display_contract.h"

namespace power_state {

struct StatusBarSnapshotIdentity {
    uint32_t len          = 0;
    uint32_t board_hash   = 0;
    uint32_t profile_hash = 0;
    int      frame_width  = 0;
    int      frame_height = 0;
    uint32_t pixel_format = 0;
    uint32_t codec        = 0;
    int      region_x      = 0;
    int      region_y      = 0;
    int      region_width  = 0;
    int      region_height = 0;
};

inline uint32_t HashSnapshotString(const char* value) noexcept {
    if (!value)
        return 0;
    uint32_t h = 2166136261u;
    while (*value != '\0') {
        h ^= static_cast<uint8_t>(*value);
        h *= 16777619u;
        ++value;
    }
    return h;
}

inline StatusBarSnapshotIdentity MakeStatusBarSnapshotIdentity(const display::DisplayInfo& display_info,
                                                               const display::FrameRegion& region,
                                                               std::size_t len) noexcept {
    return {static_cast<uint32_t>(len),
            HashSnapshotString(display_info.board_id),
            HashSnapshotString(display_info.profile_id),
            display_info.frame.width,
            display_info.frame.height,
            static_cast<uint32_t>(display_info.frame.pixel_format),
            static_cast<uint32_t>(display_info.frame.codec),
            region.x,
            region.y,
            region.width,
            region.height};
}

inline bool StatusBarSnapshotIdentityMatches(const StatusBarSnapshotIdentity& stored,
                                             const display::DisplayInfo& display_info,
                                             const display::FrameRegion& region, std::size_t len) noexcept {
    const StatusBarSnapshotIdentity expected = MakeStatusBarSnapshotIdentity(display_info, region, len);
    return stored.len == expected.len && stored.board_hash == expected.board_hash &&
           stored.profile_hash == expected.profile_hash && stored.frame_width == expected.frame_width &&
           stored.frame_height == expected.frame_height && stored.pixel_format == expected.pixel_format &&
           stored.codec == expected.codec && stored.region_x == expected.region_x &&
           stored.region_y == expected.region_y && stored.region_width == expected.region_width &&
           stored.region_height == expected.region_height;
}

}  // namespace power_state
