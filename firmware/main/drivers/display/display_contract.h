#pragma once

#include <cstddef>
#include <cstdint>

namespace display {

enum class PixelFormat {
    kMono1,
    kGray2,
    kGray4,
    kTriColor,
    kRgb565,
};

enum class FrameCodec {
    kRawMono1Msb,
};

enum class PresentMode {
    kPartial,
    kFull,
};

struct FrameDescriptor {
    int         width        = 0;
    int         height       = 0;
    PixelFormat pixel_format = PixelFormat::kMono1;
    FrameCodec  codec        = FrameCodec::kRawMono1Msb;
    std::size_t byte_size    = 0;
};

struct FrameRegion {
    int x      = 0;
    int y      = 0;
    int width  = 0;
    int height = 0;
};

struct DisplayCapabilities {
    bool audio               = false;
    bool partial_refresh     = false;
    bool previous_frame_seed = false;
};

struct DisplayInfo {
    const char*         board_id   = "";
    const char*         profile_id = "";
    FrameDescriptor     frame{};
    DisplayCapabilities capabilities{};
};

constexpr FrameDescriptor kZectrixNote4Frame{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15000};

constexpr DisplayInfo kZectrixNote4DisplayInfo{
    "zectrix-note4",
    "zectrix-note4-400x300-mono",
    kZectrixNote4Frame,
    DisplayCapabilities{true, true, true},
};

constexpr bool IsImplementedDescriptor(const FrameDescriptor& descriptor) noexcept {
    return descriptor.pixel_format == PixelFormat::kMono1 && descriptor.codec == FrameCodec::kRawMono1Msb;
}

constexpr std::size_t ExpectedFrameBytes(const FrameDescriptor& descriptor) noexcept {
    if (!IsImplementedDescriptor(descriptor) || descriptor.width <= 0 || descriptor.height <= 0 ||
        descriptor.width % 8 != 0) {
        return 0;
    }
    return static_cast<std::size_t>(descriptor.width / 8) * static_cast<std::size_t>(descriptor.height);
}

constexpr bool ValidateFrameDescriptor(const FrameDescriptor& descriptor) noexcept {
    const std::size_t expected = ExpectedFrameBytes(descriptor);
    return expected > 0 && descriptor.byte_size == expected;
}

constexpr bool ValidateRegion(const FrameRegion& region, const FrameDescriptor& descriptor) noexcept {
    if (!ValidateFrameDescriptor(descriptor) || region.x < 0 || region.y < 0 || region.width <= 0 ||
        region.height <= 0 || region.x % 8 != 0 || region.width % 8 != 0) {
        return false;
    }
    return region.x <= descriptor.width && region.y <= descriptor.height && region.width <= descriptor.width - region.x &&
           region.height <= descriptor.height - region.y;
}

constexpr std::size_t ExpectedRegionBytes(const FrameRegion& region, const FrameDescriptor& descriptor) noexcept {
    if (!ValidateRegion(region, descriptor))
        return 0;
    return static_cast<std::size_t>(region.width / 8) * static_cast<std::size_t>(region.height);
}

class Display {
   public:
    virtual ~Display() = default;

    virtual const DisplayInfo& Info() const = 0;
    virtual bool               Lock(int timeout_ms = 0) = 0;
    virtual void               Unlock() = 0;
    virtual bool               WaitForRefreshIdle(int timeout_ms) = 0;
    virtual void               RequestRefresh(PresentMode mode) = 0;
    virtual bool               Present(const FrameRegion& region, const uint8_t* data, std::size_t len,
                                       PresentMode mode) = 0;
    virtual bool               SeedPrevious(const FrameRegion& region, const uint8_t* data, std::size_t len) = 0;
    virtual bool               ReadPrevious(const FrameRegion& region, uint8_t* out, std::size_t len) = 0;
};

bool SeedPreviousIfSupported(Display& display, const FrameRegion& region, const uint8_t* data, std::size_t len);
bool ReadPreviousIfSupported(Display& display, const FrameRegion& region, uint8_t* out, std::size_t len);
bool PresentWithFallback(Display& display, const FrameRegion& region, const uint8_t* data, std::size_t len,
                         PresentMode mode);
void RequestRefreshWithFallback(Display& display, PresentMode mode);
bool PresentFrameBody(Display& display, const uint8_t* raw, std::size_t len, int status_bar_height, PresentMode mode,
                      int lock_timeout_ms = 2000);

}  // namespace display
