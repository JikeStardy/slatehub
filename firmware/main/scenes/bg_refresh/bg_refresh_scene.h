#pragma once

#include <atomic>
#include <memory>
#include <string>

#include "scenes/bg_refresh/bg_refresh_transaction.h"
#include "scenes/core/scene.h"
#include "storage/cache/cache.h"
#include "ui/status_bar.h"

class BgRefreshScene : public Scene {
   public:
    ~BgRefreshScene() override;

    const char* Name() const override {
        return "bg_refresh";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }
    bool RequiresRoot() const override {
        return false;
    }

   private:
    enum class State {
        kWaiting,
        kRendering,
        kDone,
    };

    bool SeedPreviousFrame(SceneContext& ctx);
    bool ResolveCurrentFrame(std::string& gid, int& seq, int& content_count);
    bool RenderChangedFrame(SceneContext& ctx);
    void StartWatcher(display::Display* display);
    void StartDeadlineWatchdog();
    void Finish();
    void FinishAfterCompletionClaimed();
    void ClearPendingFrameCommit();

    State                              state_                  = State::kWaiting;
    bool                               previous_screen_seeded_ = false;
    bool                               force_full_refresh_     = false;
    uint32_t                           next_generation_        = 0;
    std::shared_ptr<bg_refresh::CompletionState> completion_;
    bool                               pending_frame_commit_   = false;
    int                                pending_seq_            = 0;
    cache::FrameMeta                   pending_meta_{};

    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
};
