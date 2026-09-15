#include "bsp/board_platform.h"

#ifndef SLATE_BOARD_ID
#define SLATE_BOARD_ID "zectrix-note4"
#endif

namespace {

constexpr bool StringEquals(const char* lhs, const char* rhs) {
    return (*lhs == *rhs) && (*lhs == '\0' || StringEquals(lhs + 1, rhs + 1));
}

static_assert(StringEquals(SLATE_BOARD_ID, "zectrix-note4"),
              "Unsupported SLATE_BOARD_ID: only zectrix-note4 is implemented");

}  // namespace

namespace board {
namespace {

constexpr display::FrameDescriptor kNote4Frame{
    400, 300, display::PixelFormat::kMono1, display::FrameCodec::kRawMono1Msb, 15000};

constexpr display::DisplayInfo kNote4DisplayInfo{
    "zectrix-note4",
    "zectrix-note4-400x300-mono",
    kNote4Frame,
    display::DisplayCapabilities{true, true, true},
};

constexpr display::FrameRegion kNote4StatusBarSnapshotRegion{0, 0, 400, 24};

class Note4BoardPlatform final : public BoardPlatform {
   public:
    const char* BoardId() const override {
        return kNote4DisplayInfo.board_id;
    }

    const char* LegacyUserAgentBoardName() const override {
        return "zectrix-s3-epaper-4.2";
    }

    const display::DisplayInfo& Display() const override {
        return kNote4DisplayInfo;
    }

    display::FrameRegion StatusBarSnapshotRegion() const override {
        return kNote4StatusBarSnapshotRegion;
    }

    std::size_t StatusBarSnapshotBytes() const override {
        return display::ExpectedRegionBytes(kNote4StatusBarSnapshotRegion, kNote4Frame);
    }
};

}  // namespace

const BoardPlatform& CurrentPlatform() {
    static const Note4BoardPlatform platform;
    return platform;
}

}  // namespace board
