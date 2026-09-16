#pragma once

#include "storage/cache/cache.h"

namespace power_state {

inline int g_set_current_frame_calls = 0;

inline void ResetHostState() {
    g_set_current_frame_calls = 0;
}

inline void SetCurrentFrameFromMeta(int, const cache::FrameMeta&) {
    ++g_set_current_frame_calls;
}

}  // namespace power_state
