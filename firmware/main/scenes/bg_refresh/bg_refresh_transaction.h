#pragma once

#include <atomic>
#include <cstdint>
#include <memory>

namespace bg_refresh {

enum class CompletionStatus : uint8_t {
    kWaiting,
    kIdlePublishing,
    kIdleQueued,
    kDonePublishing,
    kDoneQueued,
    kCompleted,
    kCancelled,
};

struct CompletionState {
    explicit CompletionState(uint64_t generation_in) : generation(generation_in) {
    }

    uint64_t                      generation = 0;
    std::atomic<CompletionStatus> state{CompletionStatus::kWaiting};
};

inline uint64_t NextGeneration(std::atomic<uint64_t>& counter) noexcept {
    uint64_t next = counter.fetch_add(1, std::memory_order_acq_rel) + 1;
    if (next != 0)
        return next;
    next = counter.fetch_add(1, std::memory_order_acq_rel) + 1;
    return next == 0 ? 1 : next;
}

inline void Cancel(CompletionState* completion) noexcept {
    if (completion)
        completion->state.store(CompletionStatus::kCancelled, std::memory_order_release);
}

inline bool IsTerminal(CompletionStatus status) noexcept {
    return status == CompletionStatus::kIdleQueued || status == CompletionStatus::kDoneQueued ||
           status == CompletionStatus::kCompleted || status == CompletionStatus::kCancelled;
}

inline bool IsPublishing(CompletionStatus status) noexcept {
    return status == CompletionStatus::kIdlePublishing || status == CompletionStatus::kDonePublishing;
}

inline bool CompleteQueuedOrPublishing(CompletionState& completion, uint64_t generation,
                                       CompletionStatus publishing_status,
                                       CompletionStatus queued_status) {
    if (generation != completion.generation)
        return false;
    CompletionStatus expected = publishing_status;
    if (completion.state.compare_exchange_strong(expected, CompletionStatus::kCompleted, std::memory_order_acq_rel,
                                                 std::memory_order_acquire)) {
        return true;
    }
    expected = queued_status;
    return completion.state.compare_exchange_strong(expected, CompletionStatus::kCompleted, std::memory_order_acq_rel,
                                                    std::memory_order_acquire);
}

template <typename PostIdle>
bool QueueIdleEvent(std::shared_ptr<CompletionState> completion, PostIdle post_idle, int max_post_attempts = 1) {
    if (!completion)
        return false;
    CompletionStatus expected = CompletionStatus::kWaiting;
    if (!completion->state.compare_exchange_strong(expected, CompletionStatus::kIdlePublishing,
                                                   std::memory_order_acq_rel, std::memory_order_acquire)) {
        return false;
    }

    const int attempts = max_post_attempts > 0 ? max_post_attempts : 1;
    for (int i = 0; i < attempts; ++i) {
        CompletionStatus status = completion->state.load(std::memory_order_acquire);
        if (status == CompletionStatus::kCancelled)
            return false;
        if (status == CompletionStatus::kCompleted)
            return true;
        if (post_idle(completion->generation))
            completion->state.compare_exchange_strong(status, CompletionStatus::kIdleQueued,
                                                      std::memory_order_acq_rel, std::memory_order_acquire);
        if (completion->state.load(std::memory_order_acquire) == CompletionStatus::kIdleQueued ||
            completion->state.load(std::memory_order_acquire) == CompletionStatus::kCompleted) {
            return true;
        }
    }
    expected = CompletionStatus::kIdlePublishing;
    if (completion->state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                                  std::memory_order_acquire)) {
        return false;
    }
    return completion->state.load(std::memory_order_acquire) == CompletionStatus::kCompleted;
}

template <typename PostDone, typename Yield>
bool QueueDoneEvent(std::shared_ptr<CompletionState> completion, PostDone post_done, Yield yield_on_contention,
                    int max_post_attempts = 1, int max_claim_attempts = 8) {
    if (!completion)
        return false;
    int claim = 0;
    while (max_claim_attempts <= 0 || claim < max_claim_attempts) {
        ++claim;
        CompletionStatus status = completion->state.load(std::memory_order_acquire);
        if (IsTerminal(status))
            return false;
        if (IsPublishing(status)) {
            yield_on_contention();
            continue;
        }
        if (status != CompletionStatus::kWaiting)
            return false;

        CompletionStatus expected = CompletionStatus::kWaiting;
        if (!completion->state.compare_exchange_strong(expected, CompletionStatus::kDonePublishing,
                                                       std::memory_order_acq_rel, std::memory_order_acquire)) {
            continue;
        }

        const int post_attempts = max_post_attempts > 0 ? max_post_attempts : 1;
        for (int post = 0; post < post_attempts; ++post) {
            const CompletionStatus current = completion->state.load(std::memory_order_acquire);
            if (current == CompletionStatus::kCancelled)
                return false;
            if (current == CompletionStatus::kCompleted)
                return true;
            if (post_done(completion->generation)) {
                CompletionStatus published = CompletionStatus::kDonePublishing;
                completion->state.compare_exchange_strong(published, CompletionStatus::kDoneQueued,
                                                          std::memory_order_acq_rel, std::memory_order_acquire);
                return completion->state.load(std::memory_order_acquire) == CompletionStatus::kDoneQueued ||
                       completion->state.load(std::memory_order_acquire) == CompletionStatus::kCompleted;
            }
        }

        expected = CompletionStatus::kDonePublishing;
        if (completion->state.compare_exchange_strong(expected, CompletionStatus::kWaiting, std::memory_order_acq_rel,
                                                      std::memory_order_acquire)) {
            return false;
        }
        return completion->state.load(std::memory_order_acquire) == CompletionStatus::kCompleted;
    }
    return false;
}

template <typename WaitForIdle, typename ReleaseContext, typename PostDisplayIdle, typename PostDone, typename Yield>
bool RunWatcherCompletion(std::shared_ptr<CompletionState> completion, WaitForIdle wait_for_idle,
                          ReleaseContext release_context, PostDisplayIdle post_display_idle, PostDone post_done,
                          Yield yield_on_contention, int max_post_attempts = 1) {
    if (!completion) {
        release_context();
        return false;
    }
    const bool idle_ok = wait_for_idle();
    auto       state   = completion;
    release_context();

    if (idle_ok) {
        return QueueIdleEvent(state, post_display_idle, max_post_attempts);
    }

    return QueueDoneEvent(state, post_done, yield_on_contention, max_post_attempts);
}

template <typename IsFinished, typename ReleaseContext, typename PostDone, typename Yield>
bool RunDeadlineCompletion(std::shared_ptr<CompletionState> completion, IsFinished is_finished,
                           ReleaseContext release_context, PostDone post_done, Yield yield_on_contention,
                           int max_post_attempts = 1, int max_claim_attempts = 8) {
    if (!completion) {
        release_context();
        return false;
    }
    if (is_finished()) {
        release_context();
        return false;
    }
    auto state = completion;
    release_context();
    return QueueDoneEvent(state, post_done, yield_on_contention, max_post_attempts, max_claim_attempts);
}

template <typename Commit, typename Complete>
bool CompleteIdleOnUiTask(CompletionState& completion, uint64_t generation, Commit commit, Complete complete) {
    if (!CompleteQueuedOrPublishing(completion, generation, CompletionStatus::kIdlePublishing,
                                    CompletionStatus::kIdleQueued)) {
        return false;
    }
    commit();
    complete(completion.generation);
    return true;
}

template <typename Complete>
bool CompleteDoneOnUiTask(CompletionState& completion, uint64_t generation, Complete complete) {
    if (!CompleteQueuedOrPublishing(completion, generation, CompletionStatus::kDonePublishing,
                                    CompletionStatus::kDoneQueued)) {
        return false;
    }
    complete(completion.generation);
    return true;
}

}  // namespace bg_refresh
