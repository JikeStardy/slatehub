#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

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

struct ByteCountResult {
    bool        ok    = false;
    std::size_t bytes = 0;
};

constexpr std::size_t kMaxFrameBytes = std::numeric_limits<uint32_t>::max();

constexpr bool IsImplementedDescriptor(const FrameDescriptor& descriptor) noexcept {
    return descriptor.pixel_format == PixelFormat::kMono1 && descriptor.codec == FrameCodec::kRawMono1Msb;
}

constexpr bool CheckedMul(std::size_t lhs, std::size_t rhs, std::size_t* out) noexcept {
    if (out == nullptr)
        return false;
    if (lhs != 0 && rhs > kMaxFrameBytes / lhs)
        return false;
    *out = lhs * rhs;
    return true;
}

constexpr bool CheckedAdd(std::size_t lhs, std::size_t rhs, std::size_t* out) noexcept {
    if (out == nullptr)
        return false;
    if (lhs > kMaxFrameBytes || rhs > kMaxFrameBytes)
        return false;
    if (lhs > kMaxFrameBytes - rhs)
        return false;
    *out = lhs + rhs;
    return true;
}

constexpr ByteCountResult CalculateFrameBytes(const FrameDescriptor& descriptor) noexcept {
    if (!IsImplementedDescriptor(descriptor) || descriptor.width <= 0 || descriptor.height <= 0 ||
        descriptor.width % 8 != 0) {
        return {};
    }
    std::size_t bytes = 0;
    if (!CheckedMul(static_cast<std::size_t>(descriptor.width / 8), static_cast<std::size_t>(descriptor.height),
                    &bytes)) {
        return {};
    }
    return {true, bytes};
}

constexpr std::size_t ExpectedFrameBytes(const FrameDescriptor& descriptor) noexcept {
    const ByteCountResult result = CalculateFrameBytes(descriptor);
    return result.ok ? result.bytes : 0;
}

constexpr bool ValidateFrameDescriptor(const FrameDescriptor& descriptor) noexcept {
    const ByteCountResult expected = CalculateFrameBytes(descriptor);
    return expected.ok && expected.bytes > 0 && descriptor.byte_size == expected.bytes;
}

constexpr bool ValidateRegion(const FrameRegion& region, const FrameDescriptor& descriptor) noexcept {
    if (!ValidateFrameDescriptor(descriptor) || region.x < 0 || region.y < 0 || region.width <= 0 ||
        region.height <= 0 || region.x % 8 != 0 || region.width % 8 != 0) {
        return false;
    }
    return region.x <= descriptor.width && region.width <= descriptor.width - region.x &&
           region.y <= descriptor.height && region.height <= descriptor.height - region.y;
}

constexpr ByteCountResult CalculateRegionBytes(const FrameRegion& region, const FrameDescriptor& descriptor) noexcept {
    if (!ValidateRegion(region, descriptor))
        return {};
    std::size_t bytes = 0;
    if (!CheckedMul(static_cast<std::size_t>(region.width / 8), static_cast<std::size_t>(region.height), &bytes))
        return {};
    return {true, bytes};
}

constexpr std::size_t ExpectedRegionBytes(const FrameRegion& region, const FrameDescriptor& descriptor) noexcept {
    const ByteCountResult result = CalculateRegionBytes(region, descriptor);
    return result.ok ? result.bytes : 0;
}

constexpr ByteCountResult CalculateRegionOffsetBytes(const FrameRegion& region,
                                                     const FrameDescriptor& descriptor) noexcept {
    if (!ValidateRegion(region, descriptor))
        return {};
    std::size_t bytes_per_row = 0;
    if (!CheckedMul(static_cast<std::size_t>(descriptor.width / 8), static_cast<std::size_t>(region.y),
                    &bytes_per_row)) {
        return {};
    }
    std::size_t x_offset = 0;
    if (!CheckedMul(static_cast<std::size_t>(region.x / 8), 1, &x_offset))
        return {};
    std::size_t offset = 0;
    if (!CheckedAdd(bytes_per_row, x_offset, &offset))
        return {};
    return {true, offset};
}

constexpr std::size_t ExpectedRegionOffsetBytes(const FrameRegion& region,
                                                const FrameDescriptor& descriptor) noexcept {
    const ByteCountResult result = CalculateRegionOffsetBytes(region, descriptor);
    return result.ok ? result.bytes : 0;
}

class Display {
   public:
    Display() = default;
    virtual ~Display() = default;
    Display(const Display&) = delete;
    Display& operator=(const Display&) = delete;
    Display(Display&&) = delete;
    Display& operator=(Display&&) = delete;

    virtual const DisplayInfo& Info() const = 0;
    virtual bool               Lock(int timeout_ms = 0) = 0;
    virtual void               Unlock() = 0;
    virtual bool               WaitForRefreshIdle(int timeout_ms) = 0;
    virtual void               RequestRefresh(PresentMode mode) = 0;
    // Returns true when the refresh request and source buffer are accepted by the display driver.
    // It does not prove that the physical panel pixels have completed refreshing.
    virtual bool Present(const FrameRegion& region, const uint8_t* data, std::size_t len, PresentMode mode) = 0;
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
