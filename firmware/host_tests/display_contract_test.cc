#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>

#include "bsp/board_platform.h"
#include "drivers/display/display_contract.h"
#include "power/status_bar_snapshot_identity.h"
#include "scenes/bg_refresh/bg_refresh_transaction.h"
#include "scenes/frame/frame_load_transaction.h"

namespace {

int g_failures = 0;

void Check(bool ok, const char* expr, int line) {
    if (ok)
        return;
    std::fprintf(stderr, "CHECK failed line=%d expr=%s\n", line, expr);
    ++g_failures;
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

constexpr display::FrameDescriptor kFakeFrame{
    296, 128, display::PixelFormat::kMono1, display::FrameCodec::kRawMono1Msb, 4736};
constexpr display::DisplayInfo kFakeDisplayInfo{
    "fake-board-296x128", "fake-board-296x128-mono", kFakeFrame, {false, true, true}};
constexpr display::FrameRegion kFakeStatusRegion{0, 0, 296, 24};

class FakePlatform final : public board::BoardPlatform {
   public:
    const char* BoardId() const override {
        return kFakeDisplayInfo.board_id;
    }

    const char* LegacyUserAgentBoardName() const override {
        return "fake-board-legacy";
    }

    const display::DisplayInfo& Display() const override {
        return kFakeDisplayInfo;
    }

    display::FrameRegion StatusBarSnapshotRegion() const override {
        return kFakeStatusRegion;
    }

    std::size_t StatusBarSnapshotBytes() const override {
        return display::ExpectedRegionBytes(kFakeStatusRegion, kFakeFrame);
    }
};

class FakeDisplay final : public display::Display {
   public:
    explicit FakeDisplay(const display::DisplayInfo& info) : info_(info) {
    }

    const display::DisplayInfo& Info() const override {
        return info_;
    }

    bool Lock(int /*timeout_ms*/) override {
        ++lock_count;
        return true;
    }

    void Unlock() override {
        ++unlock_count;
    }

    bool WaitForRefreshIdle(int /*timeout_ms*/) override {
        ++wait_count;
        return true;
    }

    void RequestRefresh(display::PresentMode mode) override {
        ++refresh_count;
        last_mode = mode;
    }

    bool Present(const display::FrameRegion& region, const uint8_t* data, std::size_t len,
                 display::PresentMode mode) override {
        ++present_count;
        last_region = region;
        last_len    = len;
        last_mode   = mode;
        return present_result && data != nullptr && len == display::ExpectedRegionBytes(region, info_.frame);
    }

    bool SeedPrevious(const display::FrameRegion& /*region*/, const uint8_t* /*data*/, std::size_t /*len*/) override {
        ++seed_count;
        return seed_result;
    }

    bool ReadPrevious(const display::FrameRegion& /*region*/, uint8_t* out, std::size_t len) override {
        ++read_count;
        if (!out)
            return false;
        std::memset(out, 0xFF, len);
        return true;
    }

    display::DisplayInfo info_;
    bool                 present_result = true;
    bool                 seed_result    = true;
    int                  lock_count    = 0;
    int                  unlock_count  = 0;
    int                  wait_count    = 0;
    int                  refresh_count = 0;
    int                  present_count = 0;
    int                  seed_count    = 0;
    int                  read_count    = 0;
    std::size_t          last_len      = 0;
    display::FrameRegion last_region{};
    display::PresentMode last_mode = display::PresentMode::kFull;
};

struct FrameTransactionFake {
    bool prepare_result = true;
    bool present_result = true;
    int  order          = 0;

    int prepare_order  = 0;
    int lock_order     = 0;
    int caption_order  = 0;
    int present_order  = 0;
    int rollback_order = 0;
    int unlock_order   = 0;
    int commit_order   = 0;

    int         committed_idx = -1;
    int         audio_state   = 7;
    int         state_idx     = 2;
    std::string caption{"old"};

    bool PrepareCandidate(int /*candidate_idx*/) {
        prepare_order = ++order;
        return prepare_result;
    }

    bool LockDisplay() {
        lock_order = ++order;
        return true;
    }

    void ApplyCandidateCaption() {
        caption_order = ++order;
        caption       = "candidate";
    }

    void RenderNow() {
        ++order;
    }

    bool PresentCandidate(display::PresentMode /*mode*/) {
        present_order = ++order;
        return present_result;
    }

    void RestorePreviousCaption() {
        rollback_order = ++order;
        caption        = "old";
    }

    void UnlockDisplay() {
        unlock_order = ++order;
    }

    void CommitAccepted(int candidate_idx) {
        commit_order  = ++order;
        committed_idx = candidate_idx;
        state_idx     = candidate_idx;
        audio_state   = 11;
    }
};

struct BgRefreshTransactionFake {
    bool idle_result  = true;
    int  order        = 0;
    int  unlock_order = 0;
    int  wait_order   = 0;
    int  commit_order = 0;
    int  done_order   = 0;

    void UnlockDisplay() {
        unlock_order = ++order;
    }

    bool WaitForIdle() {
        wait_order = ++order;
        return idle_result;
    }

    void Commit() {
        commit_order = ++order;
    }

    void PostDone() {
        done_order = ++order;
    }
};

void TestNote4PlatformInfo() {
    const board::BoardPlatform& platform = board::CurrentPlatform();
    const display::DisplayInfo& info     = platform.Display();

    CHECK(std::strcmp(platform.BoardId(), "zectrix-note4") == 0);
    CHECK(std::strcmp(platform.LegacyUserAgentBoardName(), "zectrix-s3-epaper-4.2") == 0);
    CHECK(platform.StatusBarSnapshotBytes() == 1200);
    CHECK(std::strcmp(info.board_id, "zectrix-note4") == 0);
    CHECK(std::strcmp(info.profile_id, "zectrix-note4-400x300-mono") == 0);
    CHECK(info.frame.width == 400);
    CHECK(info.frame.height == 300);
    CHECK(info.frame.pixel_format == display::PixelFormat::kMono1);
    CHECK(info.frame.codec == display::FrameCodec::kRawMono1Msb);
    CHECK(info.frame.byte_size == 15000);
    CHECK(info.capabilities.audio);
    CHECK(info.capabilities.partial_refresh);
    CHECK(info.capabilities.previous_frame_seed);
    CHECK(display::ValidateFrameDescriptor(info.frame));
}

void TestIndependentFakePlatformInfo() {
    const FakePlatform platform;
    const display::DisplayInfo& info = platform.Display();

    CHECK(std::strcmp(platform.BoardId(), "fake-board-296x128") == 0);
    CHECK(std::strcmp(platform.LegacyUserAgentBoardName(), "fake-board-legacy") == 0);
    CHECK(std::strcmp(info.profile_id, "fake-board-296x128-mono") == 0);
    CHECK(info.frame.width == 296);
    CHECK(info.frame.height == 128);
    CHECK(info.frame.byte_size == 4736);
    CHECK(platform.StatusBarSnapshotRegion().height == 24);
    CHECK(platform.StatusBarSnapshotBytes() == 296 * 24 / 8);
}

void TestDescriptorByteSizeValidation() {
    using display::FrameCodec;
    using display::FrameDescriptor;
    using display::PixelFormat;

    constexpr FrameDescriptor note4{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15000};
    static_assert(display::ExpectedFrameBytes(note4) == 15000, "Note4 frame bytes");
    static_assert(display::ValidateFrameDescriptor(note4), "Note4 descriptor is valid");

    constexpr FrameDescriptor zero_width{0, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 0};
    static_assert(!display::ValidateFrameDescriptor(zero_width), "zero width rejected");

    constexpr FrameDescriptor non_aligned{401, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 15100};
    static_assert(!display::ValidateFrameDescriptor(non_aligned), "non-byte-aligned mono width rejected");

    constexpr FrameDescriptor unsupported_format{400, 300, PixelFormat::kGray2, FrameCodec::kRawMono1Msb, 30000};
    static_assert(!display::ValidateFrameDescriptor(unsupported_format), "unsupported format rejected");

    constexpr FrameDescriptor wrong_size{400, 300, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 14999};
    static_assert(!display::ValidateFrameDescriptor(wrong_size), "wrong byte size rejected");

    constexpr FrameDescriptor overflow{524288, 65537, PixelFormat::kMono1, FrameCodec::kRawMono1Msb, 65536};
    static_assert(!display::ValidateFrameDescriptor(overflow), "32-bit overflow descriptor rejected");

    std::size_t out = 123;
    CHECK(!display::CheckedAdd(1, static_cast<std::size_t>(std::numeric_limits<uint32_t>::max()) + 1, &out));
    CHECK(out == 123);
}

void TestCapabilityDegradeHelpers() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.partial_refresh      = false;
    info.capabilities.previous_frame_seed  = false;
    FakeDisplay display{info};

    const display::FrameRegion region{0, 24, 296, 104};
    uint8_t                    body[296 * 104 / 8] = {};
    uint8_t                    snapshot[296 * 24 / 8] = {};

    CHECK(!display::SeedPreviousIfSupported(display, region, body, sizeof(body)));
    CHECK(display.seed_count == 0);
    CHECK(!display::ReadPreviousIfSupported(display, {0, 0, 296, 24}, snapshot, sizeof(snapshot)));
    CHECK(display.read_count == 0);

    CHECK(display::PresentWithFallback(display, region, body, sizeof(body), display::PresentMode::kPartial));
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
    display::RequestRefreshWithFallback(display, display::PresentMode::kPartial);
    CHECK(display.refresh_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
}

void TestNoSeedDisplayCanPresentFullFrame() {
    display::DisplayInfo info = kFakeDisplayInfo;
    info.capabilities.previous_frame_seed = false;
    FakeDisplay display{info};
    uint8_t     raw[4736] = {};

    CHECK(!display::SeedPreviousIfSupported(display, {0, 0, 296, 24}, raw, 296 * 24 / 8));
    CHECK(display.seed_count == 0);
    CHECK(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kFull));
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kFull);
}

void TestPresentFailureDoesNotCommitFrame() {
    FakeDisplay display{kFakeDisplayInfo};
    display.present_result = false;
    uint8_t raw[4736] = {};

    CHECK(!display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    CHECK(display.lock_count == 1);
    CHECK(display.unlock_count == 1);
    CHECK(display.present_count == 1);
    CHECK(display.last_mode == display::PresentMode::kPartial);
}

void TestFakeDisplayDrivesGenericFramePresentation() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    CHECK(display::PresentFrameBody(display, raw, sizeof(raw), 24, display::PresentMode::kPartial));
    CHECK(display.lock_count == 1);
    CHECK(display.unlock_count == 1);
    CHECK(display.present_count == 1);
    CHECK(display.last_region.x == 0);
    CHECK(display.last_region.y == 24);
    CHECK(display.last_region.width == 296);
    CHECK(display.last_region.height == 104);
    CHECK(display.last_len == 296 * 104 / 8);

    uint8_t too_short[4735] = {};
    CHECK(!display::PresentFrameBody(display, too_short, sizeof(too_short), 24, display::PresentMode::kPartial));
    CHECK(display.present_count == 1);
}

void TestRegionOffsetOverflowProtection() {
    FakeDisplay display{kFakeDisplayInfo};
    uint8_t     raw[4736] = {};

    CHECK(!display::PresentFrameBody(display, raw, sizeof(raw), 128, display::PresentMode::kPartial));
    CHECK(display.present_count == 0);
    CHECK(display::ExpectedRegionOffsetBytes({0, 24, 296, 104}, kFakeFrame) == 888);
    CHECK(display::ExpectedRegionBytes({0, 24, 296, 104}, kFakeFrame) == 3848);
}

void TestFrameCandidateCommitKeepsCurrentOnFailure() {
    const int current   = 2;
    const int candidate = frame_scene::NextFrameCandidate(current, 4);
    CHECK(candidate == 3);
    CHECK(frame_scene::CommitFrameCandidate(current, candidate, false) == current);
    CHECK(frame_scene::CommitFrameCandidate(current, candidate, true) == candidate);
    CHECK(frame_scene::PrevFrameCandidate(0, 4) == 3);
}

void TestFrameLoadTransactionRollbackLeavesOldState() {
    FrameTransactionFake ops;
    ops.present_result = false;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(!frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.prepare_order > 0);
    CHECK(ops.caption_order > ops.lock_order);
    CHECK(ops.present_order > ops.caption_order);
    CHECK(ops.rollback_order > ops.present_order);
    CHECK(ops.unlock_order > ops.rollback_order);
    CHECK(ops.commit_order == 0);
    CHECK(ops.caption == "old");
    CHECK(ops.audio_state == 7);
    CHECK(ops.state_idx == 2);
}

void TestFrameLoadTransactionPrepareFailureIsSideEffectFree() {
    FrameTransactionFake ops;
    ops.prepare_result = false;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(!frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.prepare_order > 0);
    CHECK(ops.lock_order == 0);
    CHECK(ops.commit_order == 0);
    CHECK(ops.caption == "old");
    CHECK(ops.audio_state == 7);
    CHECK(ops.state_idx == 2);
}

void TestFrameLoadTransactionSuccessCommitsAfterUnlock() {
    FrameTransactionFake ops;

    const frame_scene::FrameLoadRequest request{2, 3, false, true, true};
    CHECK(frame_scene::RunFrameLoadTransaction(request, ops));
    CHECK(ops.rollback_order == 0);
    CHECK(ops.unlock_order > ops.present_order);
    CHECK(ops.commit_order > ops.unlock_order);
    CHECK(ops.committed_idx == 3);
    CHECK(ops.caption == "candidate");
    CHECK(ops.audio_state == 11);
    CHECK(ops.state_idx == 3);
}

void TestBgRefreshCommitsOnlyAfterIdle() {
    BgRefreshTransactionFake ops;

    ops.UnlockDisplay();
    bg_refresh::CompleteAcceptedRefreshAfterIdle(
        [&ops]() { return ops.WaitForIdle(); }, [&ops]() { ops.Commit(); }, [&ops]() { ops.PostDone(); });
    CHECK(ops.wait_order > ops.unlock_order);
    CHECK(ops.commit_order > ops.wait_order);
    CHECK(ops.done_order > ops.commit_order);

    BgRefreshTransactionFake failed;
    failed.idle_result = false;
    failed.UnlockDisplay();
    bg_refresh::CompleteAcceptedRefreshAfterIdle(
        [&failed]() { return failed.WaitForIdle(); }, [&failed]() { failed.Commit(); },
        [&failed]() { failed.PostDone(); });
    CHECK(failed.wait_order > failed.unlock_order);
    CHECK(failed.commit_order == 0);
    CHECK(failed.done_order > failed.wait_order);
}

void TestStatusBarSnapshotIdentityRejectsSameSizeLayoutChange() {
    const auto stored =
        power_state::MakeStatusBarSnapshotIdentity(kFakeDisplayInfo, {0, 0, 296, 24}, 296 * 24 / 8);

    CHECK(power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 0, 296, 24}, 296 * 24 / 8));
    CHECK(!power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 8, 296, 24}, 296 * 24 / 8));
    CHECK(!power_state::StatusBarSnapshotIdentityMatches(stored, kFakeDisplayInfo, {0, 0, 296, 16}, 296 * 16 / 8));
}

}  // namespace

int main() {
    TestNote4PlatformInfo();
    TestIndependentFakePlatformInfo();
    TestDescriptorByteSizeValidation();
    TestCapabilityDegradeHelpers();
    TestNoSeedDisplayCanPresentFullFrame();
    TestPresentFailureDoesNotCommitFrame();
    TestFakeDisplayDrivesGenericFramePresentation();
    TestRegionOffsetOverflowProtection();
    TestFrameCandidateCommitKeepsCurrentOnFailure();
    TestFrameLoadTransactionRollbackLeavesOldState();
    TestFrameLoadTransactionPrepareFailureIsSideEffectFree();
    TestFrameLoadTransactionSuccessCommitsAfterUnlock();
    TestBgRefreshCommitsOnlyAfterIdle();
    TestStatusBarSnapshotIdentityRejectsSameSizeLayoutChange();
    return g_failures == 0 ? 0 : 1;
}
