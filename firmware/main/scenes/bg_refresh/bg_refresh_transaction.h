#pragma once

#include <atomic>

namespace bg_refresh {

inline bool TryClaimCompletion(std::atomic<bool>* completion_claimed) noexcept {
    return completion_claimed && !completion_claimed->exchange(true, std::memory_order_acq_rel);
}

template <typename WaitForIdle, typename TryClaim, typename ReleaseContext, typename PostDisplayIdle,
          typename PostDone>
void RunWatcherCompletion(WaitForIdle wait_for_idle, TryClaim try_claim, ReleaseContext release_context,
                          PostDisplayIdle post_display_idle, PostDone post_done) {
    const bool idle_ok = wait_for_idle();
    const bool claimed = try_claim();
    release_context();
    if (!claimed)
        return;
    if (idle_ok) {
        if (!post_display_idle())
            post_done();
    } else {
        post_done();
    }
}

template <typename IsFinished, typename TryClaim, typename ReleaseContext, typename PostDone>
void RunDeadlineCompletion(IsFinished is_finished, TryClaim try_claim, ReleaseContext release_context,
                           PostDone post_done) {
    const bool should_post = !is_finished() && try_claim();
    release_context();
    if (should_post)
        post_done();
}

template <typename Commit, typename PostDone>
void CompleteDisplayIdleOnUiTask(Commit commit, PostDone post_done) {
    commit();
    post_done();
}

}  // namespace bg_refresh
