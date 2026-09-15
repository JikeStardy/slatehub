#pragma once

namespace frame_scene {

constexpr int NextFrameCandidate(int current, int count) noexcept {
    return count > 0 ? (current + 1) % count : current;
}

constexpr int PrevFrameCandidate(int current, int count) noexcept {
    return count > 0 ? (current - 1 + count) % count : current;
}

constexpr int CommitFrameCandidate(int current, int candidate, bool loaded) noexcept {
    return loaded ? candidate : current;
}

}  // namespace frame_scene
