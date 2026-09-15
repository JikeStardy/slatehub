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
    CHECK(ReadText(old_a) == "old-a");
    CHECK(ReadText(old_b) == "old-b");
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

}  // namespace

int main() {
    TestInstallThenRollbackRestoresAllTargets();
    TestInstallFailureRollsBackEarlierTargets();
    TestCommitFinalizesBackups();
    return g_failures == 0 ? 0 : 1;
}
