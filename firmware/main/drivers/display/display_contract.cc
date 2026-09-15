#include "drivers/display/display_contract.h"

namespace display {

bool SeedPreviousIfSupported(Display& display, const FrameRegion& region, const uint8_t* data, std::size_t len) {
    if (!display.Info().capabilities.previous_frame_seed)
        return false;
    if (data == nullptr || len != ExpectedRegionBytes(region, display.Info().frame))
        return false;
    return display.SeedPrevious(region, data, len);
}

bool ReadPreviousIfSupported(Display& display, const FrameRegion& region, uint8_t* out, std::size_t len) {
    if (!display.Info().capabilities.previous_frame_seed)
        return false;
    if (out == nullptr || len != ExpectedRegionBytes(region, display.Info().frame))
        return false;
    return display.ReadPrevious(region, out, len);
}

bool PresentWithFallback(Display& display, const FrameRegion& region, const uint8_t* data, std::size_t len,
                         PresentMode mode) {
    if (data == nullptr || len != ExpectedRegionBytes(region, display.Info().frame))
        return false;
    const PresentMode resolved =
        (mode == PresentMode::kPartial && !display.Info().capabilities.partial_refresh) ? PresentMode::kFull : mode;
    return display.Present(region, data, len, resolved);
}

void RequestRefreshWithFallback(Display& display, PresentMode mode) {
    const PresentMode resolved =
        (mode == PresentMode::kPartial && !display.Info().capabilities.partial_refresh) ? PresentMode::kFull : mode;
    display.RequestRefresh(resolved);
}

bool PresentFrameBody(Display& display, const uint8_t* raw, std::size_t len, int status_bar_height, PresentMode mode,
                      int lock_timeout_ms) {
    const FrameDescriptor& frame = display.Info().frame;
    if (!ValidateFrameDescriptor(frame) || status_bar_height < 0 || status_bar_height >= frame.height)
        return false;
    if (raw == nullptr || len != frame.byte_size)
        return false;

    const FrameRegion body{0, status_bar_height, frame.width, frame.height - status_bar_height};
    const ByteCountResult body_offset = CalculateRegionOffsetBytes(body, frame);
    const ByteCountResult body_len    = CalculateRegionBytes(body, frame);
    std::size_t           body_end    = 0;
    if (!body_offset.ok || !body_len.ok || !CheckedAdd(body_offset.bytes, body_len.bytes, &body_end) ||
        body_end > len) {
        return false;
    }
    const uint8_t* body_data = raw + body_offset.bytes;

    if (!display.Lock(lock_timeout_ms))
        return false;
    const bool ok = PresentWithFallback(display, body, body_data, body_len.bytes, mode);
    display.Unlock();
    return ok;
}

}  // namespace display
