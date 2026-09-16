#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "storage/cache/cache_staging.h"

namespace {

int g_failures = 0;

void Check(bool ok, const char* expr, int line) {
    if (ok)
        return;
    std::fprintf(stderr, "CHECK failed line=%d expr=%s\n", line, expr);
    ++g_failures;
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

bool RemoveTree(const std::string& path) {
    DIR* dir = opendir(path.c_str());
    if (!dir)
        return true;
    bool ok = true;
    while (dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string child = path + "/" + ent->d_name;
        struct stat st {};
        if (stat(child.c_str(), &st) != 0) {
            ok = false;
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            ok = RemoveTree(child) && ok;
        } else if (unlink(child.c_str()) != 0) {
            ok = false;
        }
    }
    closedir(dir);
    return rmdir(path.c_str()) == 0 && ok;
}

class TempDir {
   public:
    TempDir() {
        const char* tmpdir = std::getenv("TMPDIR");
        std::string pattern = std::string((tmpdir && tmpdir[0]) ? tmpdir : "/tmp") + "/slate_stage_test_XXXXXX";
        std::vector<char> writable(pattern.begin(), pattern.end());
        writable.push_back('\0');
        char* path = mkdtemp(writable.data());
        if (path)
            path_ = path;
    }

    ~TempDir() {
        if (!path_.empty())
            RemoveTree(path_);
    }

    bool ok() const {
        return !path_.empty();
    }

    std::string Path(const char* leaf) const {
        return path_ + "/" + leaf;
    }

   private:
    std::string path_;
};

bool RequireTempDir(const TempDir& dir) {
    CHECK(dir.ok());
    return dir.ok();
}

bool WriteText(const std::string& path, const char* text) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f)
        return false;
    const std::size_t len = std::strlen(text);
    const bool ok = std::fwrite(text, 1, len, f) == len;
    return std::fclose(f) == 0 && ok;
}

bool WriteString(const std::string& path, const std::string& text) {
    FILE* f = std::fopen(path.c_str(), "wb");
    if (!f)
        return false;
    const bool ok = std::fwrite(text.data(), 1, text.size(), f) == text.size();
    return std::fclose(f) == 0 && ok;
}

std::string ReadText(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f)
        return "";
    char buf[64] = {};
    const std::size_t n = std::fread(buf, 1, sizeof(buf) - 1, f);
    std::fclose(f);
    return std::string(buf, n);
}

bool Exists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

void TestInstallThenRollbackRestoresAllTargets() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string old_frame = dir.Path("frame.img");
    const std::string new_frame = dir.Path("stage-frame.img");
    const std::string bak_frame = dir.Path("frame.img.bak");
    const std::string old_manifest = dir.Path("manifest.json");
    const std::string new_manifest = dir.Path("stage-manifest.json");
    const std::string bak_manifest = dir.Path("manifest.json.bak");
    CHECK(WriteText(old_frame, "old-frame"));
    CHECK(WriteText(new_frame, "new-frame"));
    CHECK(WriteText(old_manifest, "old-manifest"));
    CHECK(WriteText(new_manifest, "new-manifest"));

    std::vector<cache::staging::Swap> swaps{
        {new_frame, old_frame, bak_frame},
        {new_manifest, old_manifest, bak_manifest},
    };
    CHECK(cache::staging::InstallSwaps(swaps));
    CHECK(ReadText(old_frame) == "new-frame");
    CHECK(ReadText(old_manifest) == "new-manifest");
    CHECK(Exists(bak_frame));
    CHECK(Exists(bak_manifest));

    CHECK(cache::staging::RollbackSwaps(swaps));
    CHECK(ReadText(old_frame) == "old-frame");
    CHECK(ReadText(old_manifest) == "old-manifest");
    CHECK(Exists(new_frame));
    CHECK(Exists(new_manifest));
}

void TestInstallFailureRollsBackEarlierTargets() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string old_a = dir.Path("a");
    const std::string new_a = dir.Path("stage-a");
    const std::string bak_a = dir.Path("a.bak");
    const std::string old_b = dir.Path("b");
    const std::string missing_b = dir.Path("missing-b");
    const std::string bak_b = dir.Path("b.bak");
    CHECK(WriteText(old_a, "old-a"));
    CHECK(WriteText(new_a, "new-a"));
    CHECK(WriteText(old_b, "old-b"));

    std::vector<cache::staging::Swap> swaps{
        {new_a, old_a, bak_a},
        {missing_b, old_b, bak_b},
    };
    CHECK(!cache::staging::InstallSwaps(swaps));
    CHECK(cache::staging::RollbackSwaps(swaps));
    CHECK(ReadText(old_a) == "old-a");
    CHECK(ReadText(old_b) == "old-b");
}

void TestInstallFailureWithRestoreFaultKeepsRecoveryState() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string old_a     = dir.Path("a");
    const std::string new_a     = dir.Path("stage-a");
    const std::string bak_a     = dir.Path("a.bak");
    const std::string old_b     = dir.Path("b");
    const std::string missing_b = dir.Path("missing-b");
    const std::string bak_b     = dir.Path("b.bak");
    CHECK(WriteText(old_a, "old-a"));
    CHECK(WriteText(new_a, "new-a"));
    CHECK(WriteText(old_b, "old-b"));

    std::vector<cache::staging::Swap> swaps{
        {new_a, old_a, bak_a},
        {missing_b, old_b, bak_b},
    };
    CHECK(!cache::staging::InstallSwaps(swaps));
    cache::staging::TestFailNextRename(bak_a, old_a);
    CHECK(!cache::staging::RollbackSwaps(swaps));
    CHECK(Exists(bak_a));
    CHECK(Exists(new_a));
    CHECK(swaps[0].had_target);

    CHECK(cache::staging::RollbackSwaps(swaps));
    CHECK(ReadText(old_a) == "old-a");
    CHECK(ReadText(old_b) == "old-b");
}

void TestRollbackNewOnlyMoveAndDeleteFailureKeepsInstalledForRetry() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string target = dir.Path("new-only");
    const std::string staged = dir.Path("stage-new-only");
    const std::string backup = dir.Path("new-only.bak");
    CHECK(WriteText(staged, "created"));

    std::vector<cache::staging::Swap> swaps{{staged, target, backup}};
    CHECK(cache::staging::InstallSwaps(swaps));
    CHECK(swaps[0].installed);
    CHECK(ReadText(target) == "created");

    cache::staging::TestFailNextRename(target, staged);
    cache::staging::TestFailNextUnlink(target);
    CHECK(!cache::staging::RollbackSwaps(swaps));
    CHECK(swaps[0].installed);
    CHECK(ReadText(target) == "created");
    CHECK(!Exists(staged));

    CHECK(cache::staging::RollbackSwaps(swaps));
    CHECK(!swaps[0].installed);
    CHECK(!Exists(target));
    CHECK(ReadText(staged) == "created");
}

void TestRollbackExistingTargetMoveAndDeleteFailureSkipsBackupRestoreForRetry() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string target = dir.Path("existing-target");
    const std::string staged = dir.Path("stage-existing");
    const std::string backup = dir.Path("existing-target.bak");
    CHECK(WriteText(target, "old"));
    CHECK(WriteText(staged, "new"));

    std::vector<cache::staging::Swap> swaps{{staged, target, backup}};
    CHECK(cache::staging::InstallSwaps(swaps));
    CHECK(swaps[0].installed);
    CHECK(swaps[0].had_target);
    CHECK(ReadText(target) == "new");
    CHECK(ReadText(backup) == "old");

    cache::staging::TestFailNextRename(target, staged);
    cache::staging::TestFailNextUnlink(target);
    CHECK(!cache::staging::RollbackSwaps(swaps));
    CHECK(swaps[0].installed);
    CHECK(swaps[0].had_target);
    CHECK(ReadText(target) == "new");
    CHECK(ReadText(backup) == "old");
    CHECK(!Exists(staged));

    CHECK(cache::staging::RollbackSwaps(swaps));
    CHECK(!swaps[0].installed);
    CHECK(!swaps[0].had_target);
    CHECK(ReadText(target) == "old");
    CHECK(ReadText(staged) == "new");
    CHECK(!Exists(backup));
}

void TestCommitFinalizesBackups() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string old_a = dir.Path("a");
    const std::string new_a = dir.Path("stage-a");
    const std::string bak_a = dir.Path("a.bak");
    CHECK(WriteText(old_a, "old-a"));
    CHECK(WriteText(new_a, "new-a"));

    std::vector<cache::staging::Swap> swaps{{new_a, old_a, bak_a}};
    CHECK(cache::staging::CommitSwaps(swaps));
    CHECK(ReadText(old_a) == "new-a");
    CHECK(!Exists(bak_a));
    CHECK(!Exists(new_a));
}

void TestRecoverJournalRestoresInterruptedSwapBatch() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string old_a   = dir.Path("a");
    const std::string new_a   = dir.Path("stage-a");
    const std::string bak_a   = dir.Path("a.bak");
    const std::string old_b   = dir.Path("b");
    const std::string new_b   = dir.Path("stage-b");
    const std::string bak_b   = dir.Path("b.bak");
    const std::string journal = dir.Path("transaction.journal");
    CHECK(WriteText(old_a, "old-a"));
    CHECK(WriteText(new_a, "new-a"));
    CHECK(WriteText(old_b, "old-b"));
    CHECK(WriteText(new_b, "new-b"));

    std::vector<cache::staging::Swap> swaps{
        {new_a, old_a, bak_a},
        {new_b, old_b, bak_b},
    };
    CHECK(cache::staging::WriteJournal(journal, swaps));
    CHECK(rename(old_a.c_str(), bak_a.c_str()) == 0);
    CHECK(rename(new_a.c_str(), old_a.c_str()) == 0);

    CHECK(cache::staging::RecoverJournal(journal));
    CHECK(ReadText(old_a) == "old-a");
    CHECK(ReadText(old_b) == "old-b");
    CHECK(!Exists(bak_a));
    CHECK(!Exists(bak_b));
    CHECK(!Exists(journal));
}

void TestRecoverJournalRemovesNewTargetWithoutPreviousBackup() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string target  = dir.Path("new-only");
    const std::string staged  = dir.Path("stage-new-only");
    const std::string backup  = dir.Path("new-only.bak");
    const std::string journal = dir.Path("transaction.journal");
    CHECK(WriteText(staged, "created"));

    std::vector<cache::staging::Swap> swaps{{staged, target, backup}};
    CHECK(cache::staging::WriteJournal(journal, swaps));
    CHECK(rename(staged.c_str(), target.c_str()) == 0);

    CHECK(cache::staging::RecoverJournal(journal));
    CHECK(!Exists(target));
    CHECK(!Exists(backup));
    CHECK(!Exists(journal));
}

void TestRecoverJournalDoesNotDeleteUnstartedDeleteTarget() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string target  = dir.Path("old-audio.pcm");
    const std::string backup  = dir.Path("old-audio.pcm.bak");
    const std::string journal = dir.Path("transaction.journal");
    CHECK(WriteText(target, "old-audio"));

    cache::staging::Swap swap{"", target, backup, false, false, true};
    swap.target_existed = true;
    std::vector<cache::staging::Swap> swaps{swap};
    CHECK(cache::staging::WriteJournal(journal, swaps));

    CHECK(cache::staging::RecoverJournal(journal));
    CHECK(ReadText(target) == "old-audio");
    CHECK(!Exists(backup));
    CHECK(!Exists(journal));
}

void TestRecoverJournalRejectsOverlongLineAndKeepsEvidence() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string journal = dir.Path("transaction.journal");
    std::string       huge    = "slate-cache-stage-v1\n";
    huge.append(3000, 'x');
    CHECK(WriteText(journal, huge.c_str()));

    CHECK(!cache::staging::RecoverJournal(journal));
    CHECK(Exists(journal));
}

void TestRecoverJournalRejectsTrailingPercentEscapesAndKeepsEvidence() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;

    auto check_bad_stage = [&](const char* leaf, const std::string& staged) {
        const std::string journal = dir.Path(leaf);
        CHECK(WriteString(journal, "slate-cache-stage-v1\n" + staged + "\t/target\t/backup\t0\t0\n"));
        CHECK(!cache::staging::RecoverJournal(journal));
        CHECK(Exists(journal));
    };
    check_bad_stage("percent-only.journal", "%");
    check_bad_stage("percent-short.journal", "%A");

    const std::string max_journal = dir.Path("max-percent-eof.journal");
    std::string       line;
    line.append(2035, 'a');
    line.push_back('%');
    CHECK(line.size() + std::string("\t/t\t/b\t0\t0").size() == 2046);
    CHECK(WriteString(max_journal, "slate-cache-stage-v1\n" + line + "\t/t\t/b\t0\t0"));
    CHECK(!cache::staging::RecoverJournal(max_journal));
    CHECK(Exists(max_journal));
}

void TestRemoveJournalKeepsCommitMarkerWhenTmpCleanupFails() {
    const TempDir dir;
    if (!RequireTempDir(dir))
        return;
    const std::string journal = dir.Path("transaction.journal");
    CHECK(WriteText(journal, "slate-cache-stage-v1\n"));
    CHECK(mkdir((journal + ".tmp").c_str(), 0775) == 0);

    CHECK(!cache::staging::RemoveJournal(journal));
    CHECK(Exists(journal));
}

}  // namespace

int main() {
    TestInstallThenRollbackRestoresAllTargets();
    TestInstallFailureRollsBackEarlierTargets();
    TestInstallFailureWithRestoreFaultKeepsRecoveryState();
    TestRollbackNewOnlyMoveAndDeleteFailureKeepsInstalledForRetry();
    TestRollbackExistingTargetMoveAndDeleteFailureSkipsBackupRestoreForRetry();
    TestCommitFinalizesBackups();
    TestRecoverJournalRestoresInterruptedSwapBatch();
    TestRecoverJournalRemovesNewTargetWithoutPreviousBackup();
    TestRecoverJournalDoesNotDeleteUnstartedDeleteTarget();
    TestRecoverJournalRejectsOverlongLineAndKeepsEvidence();
    TestRecoverJournalRejectsTrailingPercentEscapesAndKeepsEvidence();
    TestRemoveJournalKeepsCommitMarkerWhenTmpCleanupFails();
    return g_failures == 0 ? 0 : 1;
}
