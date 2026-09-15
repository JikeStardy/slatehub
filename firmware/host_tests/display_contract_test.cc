#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "bsp/board_platform.h"
#include "drivers/display/display_contract.h"

namespace {

class FakeDisplay final : public display::Display {
   public:
    explicit FakeDisplay(const display::DisplayInfo& info) : info_(info) {
    }

    const display::DisplayInfo& Info() const override {
        return info_;
    }

    bool Lock(int /*timeout_ms*/) override {
        ++lock_count;
        return true;
    }

    void Unlock() override {
        ++unlock_count;
    }

    bool WaitForRefreshIdle(int /*timeout_ms*/) override {
        ++wait_count;
        return true;
    }

    void RequestRefresh(display::PresentMode mode) override {
        ++refresh_count;
        last_mode = mode;
    }

    bool Present(const display::FrameRegion& region, const uint8_t* data, std::size_t len,
                 display::PresentMode mode) override {
        ++present_count;
        last_region = region;
        last_len    = len;
        last_mode   = mode;
        return data != nullptr && len == display::ExpectedRegionBytes(region, info_.frame);
    }

    bool SeedPrevious(const display::FrameRegion& /*region*/, const uint8_t* /*data*/, std::size_t /*len*/) override {
        ++seed_count;
        return true;
    }

    bool ReadPrevious(const display::FrameRegion& /*region*/, uint8_t* out, std::size_t len) override {
        ++read_count;
        if (!out)
            return false;
        std::memset(out, 0xFF, len);
        return true;
    }

    display::DisplayInfo info_;
    int                  lock_count    = 0;
    int                  unlock_count  = 0;
    int                  wait_count    = 0;
    int                  refresh_count = 0;
    int                  present_count = 0;
    int                  seed_count    = 0;
    int                  read_count    = 0;
    std::size_t          last_len      = 0;
    display::FrameRegion last_region{};
    display::PresentMode last_mode = display::PresentMode::kFull;
};

void TestNote4PlatformInfo() {
    const board::BoardPlatform& platform = board::CurrentPlatform();
    const display::DisplayInfo& info     = platform.Display();

    assert(std::strcmp(platform.BoardId(), "zectrix-note4") == 0);
    assert(std::strcmp(info.board_id, "zectrix-note4") == 0);
    assert(std::strcmp(info.profile_id, "zectrix-note4-400x300-mono") == 0);
    assert(info.frame.width == 400);
    assert(info.frame.height == 300);
    assert(info.frame.pixel_format == display::PixelFormat::kMono1);
    assert(info.frame.codec == display::FrameCodec::kRawMono1Msb);
    assert(info.frame.byte_size == 15000);
    assert(info.capabilities.audio);
    assert(info.capabilities.partial_refresh);
    assert(info.capabilities.previous_frame_seed);
    assert(display::ValidateFrameDescriptor(info.frame));
}

void TestDescriptorByteSizeValidation() {
    using display::FrameCodec;
    using display::FrameDescriptor;
    using display::PixelFormat;

    constexpr FrameDescriptor note4{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15000};
    static_assert(display::ExpectedFrameBytes(note4) == 15000, "Note4 frame bytes");
    static_assert(display::ValidateFrameDescriptor(note4), "Note4 descriptor is valid");

    constexpr FrameDescriptor zero_width{0, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 0};
    static_assert(!display::ValidateFrameDescriptor(zero_width), "zero width rejected");

    constexpr FrameDescriptor non_aligned{401, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15100};
    static_assert(!display::ValidateFrameDescriptor(non_aligned), "non-byte-aligned mono width rejected");

    constexpr FrameDescriptor unsupported_format{400, 300, PixelFormat::kGray2, FrameCodec::kRawMono1Msb, 30000};
    static_assert(!display::ValidateFrameDescriptor(unsupported_format), "unsupported format rejected");

    constexpr FrameDescriptor wrong_size{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 14999};
    static_assert(!display::ValidateFrameDescriptor(wrong_size), "wrong byte size rejected");
}

void TestCapabilityDegradeHelpers() {
    display::DisplayInfo info = board::CurrentPlatform().Display();
    info.capabilities.partial_refresh      = false;
    info.capabilities.previous_frame_seed  = false;
    FakeDisplay display{info};

    const display::FrameRegion region{0, 24, 400, 276};
    uint8_t                    body[400 * 276 / 8] = {};
    uint8_t                    snapshot[400 * 24 / 8] = {};

    assert(!display::SeedPreviousIfSupported(display, region, body, sizeof(body)));
    assert(display.seed_count == 0);
    assert(!display::ReadPreviousIfSupported(display, {0, 0, 400, 24}, snapshot, sizeof(snapshot)));
    assert(display.read_count == 0);

    assert(display::PresentWithFallback(display, region, body, sizeof(body), display::PresentMode::kPartial));
    assert(display.present_count == 1);
    assert(display.last_mode == display::PresentMode::kFull);
}

void TestFakeDisplayDrivesGenericFramePresentation() {
    FakeDisplay display{board::CurrentPlatform().Display()};
    uint8_t     raw[15000] = {};

    assert(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    assert(display.lock_count == 1);
    assert(display.unlock_count == 1);
    assert(display.present_count == 1);
    assert(display.last_region.x == 0);
    assert(display.last_region.y == 24);
    assert(display.last_region.width == 400);
    assert(display.last_region.height == 276);
    assert(display.last_len == 400 * 276 / 8);

    uint8_t too_short[14999] = {};
    assert(!display::PresentFrameBody(display, too_short, sizeof(too_short), 24, display::PresentMode::kPartial));
    assert(display.present_count == 1);
}

}  // namespace

int main() {
    TestNote4PlatformInfo();
    TestDescriptorByteSizeValidation();
    TestCapabilityDegradeHelpers();
    TestFakeDisplayDrivesGenericFramePresentation();
    return 0;
}
