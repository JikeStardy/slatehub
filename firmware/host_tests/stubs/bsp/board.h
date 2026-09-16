#pragma once

#include "drivers/display/display_contract.h"

namespace board {

class HostBoardPlatform {
   public:
    const display::DisplayInfo& Display() const {
        static constexpr display::FrameDescriptor kFrame{400,
                                                         300,
                                                         display::PixelFormat::kMono1,
                                                         display::FrameCodec::kRawMono1Msb,
                                                         15000};
        static constexpr display::DisplayInfo kDisplay{"zectrix-note4",
                                                       "zectrix-note4-400x300-mono",
                                                       kFrame,
                                                       {true, true, true}};
        return kDisplay;
    }
};

}  // namespace board

class Board {
   public:
    static Board& Get() {
        static Board board;
        return board;
    }

    const board::HostBoardPlatform& platform() const {
        return platform_;
    }

   private:
    board::HostBoardPlatform platform_;
};
