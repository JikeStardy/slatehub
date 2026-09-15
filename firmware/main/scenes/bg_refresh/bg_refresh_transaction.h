#pragma once

#include <atomic>
#include <cstdint>

namespace bg_refresh {

enum class CompletionStatus : uint8_t {
    kWaiting,
    kIdlePosting,
    kIdleQueued,
    kDoneQueued,
    kCancelled,
};

struct CompletionState {
    explicit CompletionState(uint32_t generation_in) : generation(generation_in) {
    }

    uint32_t                      generation = 0;
    std::atomic<CompletionStatus> state{CompletionStatus::kWaiting};
};

inline void Cancel(CompletionState* completion) noexcept {
    if (completion)
        completion->state.store(CompletionStatus::kCancelled, std::memory_order_release);
}

inline bool IsTerminal(CompletionStatus status) noexcept {
    return status == CompletionStatus::kIdleQueued || status == CompletionStatus::kDoneQueued ||
           status == CompletionStatus::kCancelled;
}

template <typename PostIdle>
bool QueueIdleEvent(CompletionState& completion, PostIdle post_idle, int max_post_attempts = 1) {
    CompletionStatus expected = CompletionStatus::kWaiting;
    if (!completion.state.compare_exchange_strong(expected, CompletionStatus::kIdlePosting, std::memory_order_acq_rel,
                                                  std::memory_order_acquire)) {
        return false;
    }

    const int attempts = max_post_attempts > 0 ? max_post_attempts : 1;
    for (int i = 0; i < attempts; ++i) {
        if (completion.state.load(std::memory_order_acquire) == CompletionStatus::kCancelled)
            return false;
        if (post_idle(completion.generation)) {
            completion.state.store(CompletionStatus::kIdleQueued, std::memory_order_release);
            return true;
        }
    }
    expected = CompletionStatus::kIdlePosting;
    completion.state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                             std::memory_order_acquire);
    return false;
}

template <typename PostDone>
bool QueueDoneEvent(CompletionState& completion, PostDone post_done, int max_post_attempts = 1,
                    int max_claim_attempts = 8) {
    const int claim_attempts = max_claim_attempts > 0 ? max_claim_attempts : 1;
    for (int claim = 0; claim < claim_attempts; ++claim) {
        CompletionStatus status = completion.state.load(std::memory_order_acquire);
        if (IsTerminal(status))
            return false;
        if (status == CompletionStatus::kIdlePosting)
            continue;
        if (status != CompletionStatus::kWaiting)
            return false;

        CompletionStatus expected = CompletionStatus::kWaiting;
        if (!completion.state.compare_exchange_strong(expected, CompletionStatus::kIdlePosting,
                                                      std::memory_order_acq_rel, std::memory_order_acquire)) {
            continue;
        }

        const int post_attempts = max_post_attempts > 0 ? max_post_attempts : 1;
        for (int post = 0; post < post_attempts; ++post) {
            if (completion.state.load(std::memory_order_acquire) == CompletionStatus::kCancelled)
                return false;
            if (post_done(completion.generation)) {
                completion.state.store(CompletionStatus::kDoneQueued, std::memory_order_release);
                return true;
            }
        }

        expected = CompletionStatus::kIdlePosting;
        completion.state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                                 std::memory_order_acquire);
        return false;
    }
    return false;
}

template <typename WaitForIdle, typename ReleaseContext, typename PostDisplayIdle, typename PostDone>
bool RunWatcherCompletion(CompletionState& completion, WaitForIdle wait_for_idle, ReleaseContext release_context,
                          PostDisplayIdle post_display_idle, PostDone post_done, int max_post_attempts = 1) {
    const bool idle_ok = wait_for_idle();
    if (idle_ok) {
        CompletionStatus expected = CompletionStatus::kWaiting;
        if (!completion.state.compare_exchange_strong(expected, CompletionStatus::kIdlePosting,
                                                      std::memory_order_acq_rel, std::memory_order_acquire)) {
            release_context();
            return false;
        }
        release_context();
        const int attempts = max_post_attempts > 0 ? max_post_attempts : 1;
        for (int i = 0; i < attempts; ++i) {
            if (completion.state.load(std::memory_order_acquire) == CompletionStatus::kCancelled)
                return false;
            if (post_display_idle(completion.generation)) {
                completion.state.store(CompletionStatus::kIdleQueued, std::memory_order_release);
                return true;
            }
        }
        expected = CompletionStatus::kIdlePosting;
        completion.state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                                 std::memory_order_acquire);
        return false;
    }

    CompletionStatus expected = CompletionStatus::kWaiting;
    if (!completion.state.compare_exchange_strong(expected, CompletionStatus::kIdlePosting, std::memory_order_acq_rel,
                                                  std::memory_order_acquire)) {
        release_context();
        return false;
    }
    release_context();
    const int attempts = max_post_attempts > 0 ? max_post_attempts : 1;
    for (int i = 0; i < attempts; ++i) {
        if (completion.state.load(std::memory_order_acquire) == CompletionStatus::kCancelled)
            return false;
        if (post_done(completion.generation)) {
            completion.state.store(CompletionStatus::kDoneQueued, std::memory_order_release);
            return true;
        }
    }
    expected = CompletionStatus::kIdlePosting;
    completion.state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                             std::memory_order_acquire);
    return false;
}

template <typename IsFinished, typename ReleaseContext, typename PostDone>
bool RunDeadlineCompletion(CompletionState& completion, IsFinished is_finished, ReleaseContext release_context,
                           PostDone post_done, int max_post_attempts = 1) {
    if (is_finished()) {
        release_context();
        return false;
    }
    bool claimed = false;
    for (int claim = 0; claim < 8; ++claim) {
        CompletionStatus status = completion.state.load(std::memory_order_acquire);
        if (IsTerminal(status) || status == CompletionStatus::kIdleQueued) {
            release_context();
            return false;
        }
        if (status == CompletionStatus::kIdlePosting)
            continue;
        CompletionStatus expected = CompletionStatus::kWaiting;
        if (completion.state.compare_exchange_strong(expected, CompletionStatus::kIdlePosting,
                                                     std::memory_order_acq_rel, std::memory_order_acquire)) {
            claimed = true;
            break;
        }
    }
    if (!claimed) {
        release_context();
        return false;
    }
    release_context();
    const int attempts = max_post_attempts > 0 ? max_post_attempts : 1;
    for (int i = 0; i < attempts; ++i) {
        if (completion.state.load(std::memory_order_acquire) == CompletionStatus::kCancelled)
            return false;
        if (post_done(completion.generation)) {
            completion.state.store(CompletionStatus::kDoneQueued, std::memory_order_release);
            return true;
        }
    }
    CompletionStatus expected = CompletionStatus::kIdlePosting;
    completion.state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                             std::memory_order_acquire);
    return false;
}

template <typename Commit, typename PostDone>
bool CompleteDisplayIdleOnUiTask(CompletionState& completion, uint32_t generation, Commit commit,
                                 PostDone post_done) {
    if (generation != completion.generation)
        return false;
    CompletionStatus expected = CompletionStatus::kIdleQueued;
    if (!completion.state.compare_exchange_strong(expected, CompletionStatus::kDoneQueued, std::memory_order_acq_rel,
                                                  std::memory_order_acquire)) {
        return false;
    }
    commit();
    return post_done(completion.generation);
}

}  // namespace bg_refresh
