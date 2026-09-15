#pragma once

#include <cstddef>

#include "drivers/display/display_contract.h"

namespace board {

constexpr std::size_t kStatusBarSnapshotCapacityBytes = 1200;

class BoardPlatform {
   public:
    BoardPlatform() = default;
    virtual ~BoardPlatform() = default;
    BoardPlatform(const BoardPlatform&) = delete;
    BoardPlatform& operator=(const BoardPlatform&) = delete;
    BoardPlatform(BoardPlatform&&) = delete;
    BoardPlatform& operator=(BoardPlatform&&) = delete;

    virtual const char*                 BoardId() const = 0;
    virtual const char*                 LegacyUserAgentBoardName() const = 0;
    virtual const display::DisplayInfo& Display() const = 0;
    virtual display::FrameRegion        StatusBarSnapshotRegion() const = 0;
    virtual std::size_t                 StatusBarSnapshotBytes() const = 0;
};

const BoardPlatform& CurrentPlatform();

}  // namespace board
