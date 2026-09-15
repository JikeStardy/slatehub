#pragma once

#include "drivers/display/display_contract.h"

namespace board {

class BoardPlatform {
   public:
    virtual ~BoardPlatform() = default;

    virtual const char*                 BoardId() const = 0;
    virtual const display::DisplayInfo& Display() const = 0;
};

const BoardPlatform& CurrentPlatform();

}  // namespace board

