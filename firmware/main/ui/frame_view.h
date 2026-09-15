#pragma once

#include <lvgl.h>

#include <vector>

#include "drivers/display/display_contract.h"

class FrameView {
   public:
    explicit FrameView(lv_obj_t* parent);

    void SetFrame(display::Display* display, const std::vector<uint8_t>& raw,
                  display::PresentMode mode = display::PresentMode::kPartial);
    void Show();
    void Hide();

   private:
    lv_obj_t* container_ = nullptr;
};
