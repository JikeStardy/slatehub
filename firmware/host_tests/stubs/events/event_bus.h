#pragma once

#include <cstdint>
#include <string>

#include "freertos/FreeRTOS.h"

enum class GroupSyncStatusMode : uint8_t {
    kInitialGroupDownloading,
    kCurrentGroupUpdating,
    kCycleDownloading,
    kCurrentGroupSaving,
    kTargetGroupSaving,
    kCycleCacheHit,
};

namespace evt {

inline bool PostGroupSyncStatus(GroupSyncStatusMode, const std::string&, const std::string&, uint8_t = 0, uint8_t = 0,
                                TickType_t = 0) {
    return true;
}

inline bool PostSyncProgress(uint8_t, uint8_t, TickType_t = 0) {
    return true;
}

}  // namespace evt
