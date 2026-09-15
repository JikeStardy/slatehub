#pragma once

#include "drivers/display/display_contract.h"

namespace frame_scene {

struct FrameLoadRequest {
    int  current_idx             = 0;
    int  candidate_idx           = 0;
    bool force_full              = false;
    bool first_loaded            = false;
    bool first_load_full_refresh = true;
};

constexpr int NextFrameCandidate(int current, int count) noexcept {
    return count > 0 ? (current + 1) % count : current;
}

constexpr int PrevFrameCandidate(int current, int count) noexcept {
    return count > 0 ? (current - 1 + count) % count : current;
}

constexpr int CommitFrameCandidate(int current, int candidate, bool loaded) noexcept {
    return loaded ? candidate : current;
}

constexpr display::PresentMode ResolvePresentMode(const FrameLoadRequest& request) noexcept {
    return (request.force_full || (!request.first_loaded && request.first_load_full_refresh))
               ? display::PresentMode::kFull
               : display::PresentMode::kPartial;
}

template <typename PrepareCandidate, typename LockDisplay, typename ApplyCandidateCaption, typename RenderNow,
          typename PresentCandidate, typename RestorePreviousCaption, typename UnlockDisplay, typename CommitAccepted>
bool RunFrameLoadTransaction(const FrameLoadRequest& request, PrepareCandidate prepare_candidate,
                             LockDisplay lock_display, ApplyCandidateCaption apply_candidate_caption,
                             RenderNow render_now, PresentCandidate present_candidate,
                             RestorePreviousCaption restore_previous_caption, UnlockDisplay unlock_display,
                             CommitAccepted commit_accepted) {
    if (!prepare_candidate(request.candidate_idx))
        return false;
    if (!lock_display())
        return false;

    apply_candidate_caption();
    render_now();
    if (!present_candidate(ResolvePresentMode(request))) {
        restore_previous_caption();
        render_now();
        unlock_display();
        return false;
    }

    unlock_display();
    commit_accepted(request.candidate_idx);
    return true;
}

template <typename Ops>
bool RunFrameLoadTransaction(const FrameLoadRequest& request, Ops& ops) {
    return RunFrameLoadTransaction(
        request,
        [&ops](int candidate_idx) { return ops.PrepareCandidate(candidate_idx); },
        [&ops]() { return ops.LockDisplay(); },
        [&ops]() { ops.ApplyCandidateCaption(); },
        [&ops]() { ops.RenderNow(); },
        [&ops](display::PresentMode mode) { return ops.PresentCandidate(mode); },
        [&ops]() { ops.RestorePreviousCaption(); },
        [&ops]() { ops.UnlockDisplay(); },
        [&ops](int candidate_idx) { ops.CommitAccepted(candidate_idx); });
}

}  // namespace frame_scene
