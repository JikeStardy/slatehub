#include "ui/frame_view.h"

#include <esp_log.h>

#include "ui/theme.h"

namespace {
constexpr char kTag[]      = "frame_view";
constexpr int  kStatusBarH = theme::kStatusBarHeight;
}  // namespace

FrameView::FrameView(lv_obj_t* parent) {
    container_ = lv_obj_create(parent);
    lv_obj_set_size(container_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(container_, 0, 0);
    lv_obj_set_style_bg_color(container_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(container_, 0, 0);
    lv_obj_set_style_border_width(container_, 0, 0);
    lv_obj_clear_flag(container_, LV_OBJ_FLAG_SCROLLABLE);
}

bool FrameView::SetFrame(display::Display* display, const std::vector<uint8_t>& raw, display::PresentMode mode) {
    if (!display)
        return false;
    const display::FrameDescriptor& frame = display->Info().frame;
    if (!display::ValidateFrameDescriptor(frame) || raw.size() != frame.byte_size) {
        ESP_LOGW(kTag, "raw size mismatch bytes=%u expected=%u", static_cast<unsigned>(raw.size()),
                 static_cast<unsigned>(frame.byte_size));
        return false;
    }
    if (!display::PresentFrameBody(*display, raw.data(), raw.size(), kStatusBarH, mode)) {
        ESP_LOGW(kTag, "raw present failed bytes=%u", static_cast<unsigned>(raw.size()));
        return false;
    }
    return true;
}

void FrameView::Show() {
    if (container_)
        lv_obj_clear_flag(container_, LV_OBJ_FLAG_HIDDEN);
}

void FrameView::Hide() {
    if (container_)
        lv_obj_add_flag(container_, LV_OBJ_FLAG_HIDDEN);
}
