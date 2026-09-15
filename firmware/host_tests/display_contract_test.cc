#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "bsp/board_platform.h"
#include "drivers/display/display_contract.h"

namespace {

constexpr display::FrameDescriptor kFakeFrame{
    296, 128, display::PixelFormat::kMono1, display::FrameCodec::kRawMono1Msb, 4736};
constexpr display::DisplayInfo kFakeDisplayInfo{
    "fake-board-296x128", "fake-board-296x128-mono", kFakeFrame, {false, true, true}};
constexpr display::FrameRegion kFakeStatusRegion{0, 0, 296, 24};

class FakePlatform final : public board::BoardPlatform {
   public:
    const char* BoardId() const override {
        return kFakeDisplayInfo.board_id;
    }

    const char* LegacyUserAgentBoardName() const override {
        return "fake-board-legacy";
    }

    const display::DisplayInfo& Display() const override {
        return kFakeDisplayInfo;
    }

    display::FrameRegion StatusBarSnapshotRegion() const override {
        return kFakeStatusRegion;
    }

    std::size_t StatusBarSnapshotBytes() const override {
        return display::ExpectedRegionBytes(kFakeStatusRegion, kFakeFrame);
    }
};

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
        return present_result && data != nullptr && len == display::ExpectedRegionBytes(region, info_.frame);
    }

    bool SeedPrevious(const display::FrameRegion& /*region*/, const uint8_t* /*data*/, std::size_t /*len*/) override {
        ++seed_count;
        return seed_result;
    }

    bool ReadPrevious(const display::FrameRegion& /*region*/, uint8_t* out, std::size_t len) override {
        ++read_count;
        if (!out)
            return false;
        std::memset(out, 0xFF, len);
        return true;
    }

    display::DisplayInfo info_;
    bool                 present_result = true;
    bool                 seed_result    = true;
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
    assert(std::strcmp(platform.LegacyUserAgentBoardName(), "zectrix-s3-epaper-4.2") == 0);
    assert(platform.StatusBarSnapshotBytes() == 1200);
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

void TestIndependentFakePlatformInfo() {
    const FakePlatform platform;
    const display::DisplayInfo& info = platform.Display();

    assert(std::strcmp(platform.BoardId(), "fake-board-296x128") == 0);
    assert(std::strcmp(platform.LegacyUserAgentBoardName(), "fake-board-legacy") == 0);
    assert(std::strcmp(info.profile_id, "fake-board-296x128-mono") == 0);
    assert(info.frame.width == 296);
    assert(info.frame.height == 128);
    assert(info.frame.byte_size == 4736);
    assert(platform.StatusBarSnapshotRegion().height == 24);
    assert(platform.StatusBarSnapshotBytes() == 296 * 24 / 8);
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

    constexpr FrameDescriptor overflow{524288, 65537, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 65536};
    static_assert(!display::ValidateFrameDescriptor(overflow), "32-bit overflow descriptor rejected");
}

void TestCapabilityDegradeHelpers() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.partial_refresh      = false;
    info.capabilities.previous_frame_seed  = false;
    FakeDisplay display{info};

    const display::FrameRegion region{0, 24, 296, 104};
    uint8_t                    body[296 * 104 / 8] = {};
    uint8_t                    snapshot[296 * 24 / 8] = {};

    assert(!display::SeedPreviousIfSupported(display, region, body, sizeof(body)));
    assert(display.seed_count == 0);
    assert(!display::ReadPreviousIfSupported(display, {0, 0, 296, 24}, snapshot, sizeof(snapshot)));
    assert(display.read_count == 0);

    assert(display::PresentWithFallback(display, region, body, sizeof(body), display::PresentMode::kPartial));
    assert(display.present_count == 1);
    assert(display.last_mode == display::PresentMode::kFull);
    display::RequestRefreshWithFallback(display, display::PresentMode::kPartial);
    assert(display.refresh_count == 1);
    assert(display.last_mode == display::PresentMode::kFull);
}

void TestNoSeedDisplayCanPresentFullFrame() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.previous_frame_seed = false;
    FakeDisplay display{info};
    uint8_t     raw[4736] = {};

    assert(!display::SeedPreviousIfSupported(display, {0, 0, 296, 24}, raw, 296 * 24 / 8));
    assert(display.seed_count == 0);
    assert(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kFull));
    assert(display.present_count == 1);
    assert(display.last_mode == display::PresentMode::kFull);
}

void TestPresentFailureDoesNotCommitFrame() {
    FakeDisplay display{kFakeDisplayInfo};
    display.present_result = false;
    uint8_t raw[4736] = {};

    assert(!display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    assert(display.lock_count == 1);
    assert(display.unlock_count == 1);
    assert(display.present_count == 1);
    assert(display.last_mode == display::PresentMode::kPartial);
}

void TestFakeDisplayDrivesGenericFramePresentation() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    assert(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    assert(display.lock_count == 1);
    assert(display.unlock_count == 1);
    assert(display.present_count == 1);
    assert(display.last_region.x == 0);
    assert(display.last_region.y == 24);
    assert(display.last_region.width == 296);
    assert(display.last_region.height == 104);
    assert(display.last_len == 296 * 104 / 8);

    uint8_t too_short[4735] = {};
    assert(!display::PresentFrameBody(display, too_short, sizeof(too_short), 24, display::PresentMode::kPartial));
    assert(display.present_count == 1);
}

void TestRegionOffsetOverflowProtection() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    assert(!display::PresentFrameBody(display, raw, sizeof(raw), 128, display::PresentMode::kPartial));
    assert(display.present_count == 0);
    assert(display::ExpectedRegionOffsetBytes({0, 24, 296, 104}, kFakeFrame) == 888);
    assert(display::ExpectedRegionBytes({0, 24, 296, 104}, kFakeFrame) == 3848);
}

}  // namespace

int main() {
    TestNote4PlatformInfo();
    TestIndependentFakePlatformInfo();
    TestDescriptorByteSizeValidation();
    TestCapabilityDegradeHelpers();
    TestNoSeedDisplayCanPresentFullFrame();
    TestPresentFailureDoesNotCommitFrame();
    TestFakeDisplayDrivesGenericFramePresentation();
    TestRegionOffsetOverflowProtection();
    return 0;
}
