#pragma once

namespace bg_refresh {

template <typename WaitForIdle, typename Commit, typename PostDone>
void CompleteAcceptedRefreshAfterIdle(WaitForIdle wait_for_idle, Commit commit, PostDone post_done) {
    if (wait_for_idle())
        commit();
    post_done();
}

}  // namespace bg_refresh
