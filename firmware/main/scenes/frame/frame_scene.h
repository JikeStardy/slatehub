#pragma once

// 主场景：显示服务端渲染好的完整 1bpp frame，顶部 24px 状态栏叠加。

#include <memory>
#include <string>

#include "scenes/core/scene.h"

class StatusBar;
class FrameView;

class FrameScene : public Scene {
   public:
    FrameScene(SceneContext& ctx, const char* gid, int content_count);
    ~FrameScene() override;

    const char* Name() const override {
        return "frame";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    enum class AudioBehavior {
        RestartIfAvailable,
        StopIfUnavailable,
    };

    bool LoadFrame(SceneContext& ctx, int idx, bool force_full, AudioBehavior audio_behavior);
    void NextFrame(SceneContext& ctx);
    void PrevFrame(SceneContext& ctx);
    void CycleGroup(SceneContext& ctx, bool next);
    void RebindGroup(SceneContext& ctx, const char* gid, int content_count);
    void ApplyEmptyState();
    void HandleGroupSyncStatus(SceneContext& ctx, const UiEvent& e);
    void RefreshStatusBarForCharge(SceneContext& ctx, const UiEvent& e);
    void RefreshStatusBarForBattery(SceneContext& ctx, const UiEvent& e);
    void RefreshStatusBarForWifi(SceneContext& ctx, const UiEvent& e);
    void RestoreStatusBarCaption(SceneContext& ctx);

    std::string gid_;
    int         content_count_           = 0;
    int         idx_                     = 0;
    bool        first_loaded_            = false;
    bool        first_load_full_refresh_ = true;
    std::string cached_status_bar_text_;

    lv_obj_t*                  root_        = nullptr;
    lv_obj_t*                  empty_label_ = nullptr;
    std::unique_ptr<FrameView> frame_view_;
    std::unique_ptr<StatusBar> status_bar_;
};
