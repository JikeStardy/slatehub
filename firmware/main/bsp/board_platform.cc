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

class Note4BoardPlatform final : public BoardPlatform {
   public:
    const char* BoardId() const override {
        return display::kZectrixNote4DisplayInfo.board_id;
    }

    const display::DisplayInfo& Display() const override {
        return display::kZectrixNote4DisplayInfo;
    }
};

}  // namespace

const BoardPlatform& CurrentPlatform() {
    static const Note4BoardPlatform platform;
    return platform;
}

}  // namespace board
