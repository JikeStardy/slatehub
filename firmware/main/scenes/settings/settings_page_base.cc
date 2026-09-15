#include "scenes/settings/settings_page_base.h"

#include <utility>

#include "ui/theme.h"

bool SettingsPageBase::EnterSettingsScaffold(SceneContext& ctx, const char* caption) {
    if (!ctx.epd->Lock(2000))
        return false;

    root_       = CreateFullscreenRoot();
    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption(caption ? caption : "");
    RefreshStatusBarFromSensors(ctx, *status_bar_);
    return true;
}

void SettingsPageBase::FinishSettingsScaffoldEnter(SceneContext& ctx) {
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}

void SettingsPageBase::ExitSettingsScaffold(SceneContext& ctx, std::function<void()> cleanup) {
    DestroyRoot(ctx, root_, [this, cleanup = std::move(cleanup)]() mutable {
        if (cleanup)
            cleanup();
        status_bar_.reset();
    });
}

lv_obj_t* SettingsPageBase::CreateBottomHint(const char* text) {
    auto* hint = lv_label_create(root_);
    lv_obj_set_style_text_font(hint, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint, text ? text : "");
    lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -16);
    return hint;
}
