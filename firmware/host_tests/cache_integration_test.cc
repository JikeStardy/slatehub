#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "cJSON.h"
#include "storage/cache/cache.h"
#include "storage/cache/cache_internal.h"
#include "storage/cache/cache_io.h"
#include "storage/cache/cache_paths.h"

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

class TempCacheRoot {
   public:
    TempCacheRoot() {
        const char* tmpdir = std::getenv("TMPDIR");
        std::string pattern = std::string((tmpdir && tmpdir[0]) ? tmpdir : "/tmp") + "/slate_cache_integration_XXXXXX";
        std::vector<char> writable(pattern.begin(), pattern.end());
        writable.push_back('\0');
        char* path = mkdtemp(writable.data());
        if (!path)
            return;
        root_ = path;
        setenv("SLATE_CACHE_ROOT", root_.c_str(), 1);
        cache::internal::ResetStateCache();
    }

    ~TempCacheRoot() {
        cache::internal::ResetStateCache();
        if (!root_.empty())
            RemoveTree(root_);
        unsetenv("SLATE_CACHE_ROOT");
    }

    bool ok() const {
        return !root_.empty();
    }

    const std::string& root() const {
        return root_;
    }

   private:
    std::string root_;
};

bool Exists(const std::string& path) {
    struct stat st {};
    return stat(path.c_str(), &st) == 0;
}

bool WriteText(const std::string& path, const std::string& text) {
    return cache::internal::WriteAll(path, text.data(), text.size());
}

void TestCjsonBoundedNumberParsing() {
    const char truncated[] = {'{', '"', 'x', '"', ':', '1', '2', '3'};
    char*      exact       = static_cast<char*>(std::malloc(sizeof(truncated)));
    CHECK(exact != nullptr);
    if (!exact)
        return;
    std::memcpy(exact, truncated, sizeof(truncated));
    cJSON* bad = cJSON_ParseWithLength(exact, sizeof(truncated));
    CHECK(bad == nullptr);
    std::free(exact);

    const char illegal[] = "{\"x\":123abc}";
    CHECK(cJSON_ParseWithLength(illegal, sizeof(illegal) - 1) == nullptr);

    const char valid[] = "{\"int\":-123,\"frac\":12.5,\"exp\":6.02e3}";
    cJSON* root = cJSON_ParseWithLength(valid, sizeof(valid) - 1);
    CHECK(root != nullptr);
    if (!root)
        return;
    cJSON* int_value = cJSON_GetObjectItemCaseSensitive(root, "int");
    cJSON* frac_value = cJSON_GetObjectItemCaseSensitive(root, "frac");
    cJSON* exp_value = cJSON_GetObjectItemCaseSensitive(root, "exp");
    CHECK(cJSON_IsNumber(int_value));
    CHECK(cJSON_IsNumber(frac_value));
    CHECK(cJSON_IsNumber(exp_value));
    CHECK(int_value->valueint == -123);
    CHECK(frac_value->valuedouble == 12.5);
    CHECK(exp_value->valuedouble == 6020.0);
    cJSON_Delete(root);
}

std::string ReadText(const std::string& path) {
    std::vector<uint8_t> bytes;
    if (!cache::internal::ReadAll(path, bytes, 65536))
        return "";
    return std::string(bytes.begin(), bytes.end());
}

const display::DisplayInfo& TestDisplay() {
    static constexpr display::FrameDescriptor kFrame{400,
                                                     300,
                                                     display::PixelFormat::kMono1,
                                                     display::FrameCodec::kRawMono1Msb,
                                                     15000};
    static constexpr display::DisplayInfo kDisplay{"zectrix-note4",
                                                   "zectrix-note4-400x300-mono",
                                                   kFrame,
                                                   {true, true, true}};
    return kDisplay;
}

cache::FrameMeta MakeMeta(const std::string& status, const std::string& content_etag, const std::string& image_etag,
                          const std::string& audio_etag) {
    cache::FrameMeta meta;
    meta.status_bar_text = status;
    meta.content_etag = content_etag;
    meta.image_etag = image_etag;
    meta.audio_etag = audio_etag;
    meta.profile_id = TestDisplay().profile_id;
    meta.width = TestDisplay().frame.width;
    meta.height = TestDisplay().frame.height;
    meta.pixel_format = "mono1";
    meta.frame_codec = "raw_mono1_msb";
    meta.byte_length = TestDisplay().frame.byte_size;
    return meta;
}

void SeedCommittedFrame(const std::string& gid, int idx, const std::string& image_etag,
                        const std::string& audio_etag, uint8_t image_byte, uint8_t audio_byte) {
    CHECK(cache::internal::DirEnsure(std::string(cache::internal::RootPath()) + "/groups"));
    std::vector<uint8_t> image(TestDisplay().frame.byte_size, image_byte);
    std::vector<uint8_t> audio(4, audio_byte);
    CHECK(cache::WriteFrameImage(gid, idx, image, image_etag, TestDisplay().frame));
    if (!audio_etag.empty())
        CHECK(cache::WriteFrameAudio(gid, idx, audio, audio_etag));
    CHECK(cache::WriteFrameMeta(gid, idx, MakeMeta("old", "content-old", image_etag, audio_etag)));
}

void TestIdentitylessManifestAndFrameMetadataInvalidate() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    CHECK(cache::internal::DirEnsure(std::string(cache::internal::RootPath()) + "/groups"));
    CHECK(cache::internal::DirEnsure(cache::internal::GroupDir(gid)));
    CHECK(cache::internal::DirEnsure(cache::internal::FramesDir(gid)));
    CHECK(WriteText(cache::internal::ManifestPath(gid),
                    "{\"group_id\":\"group-a\",\"group_name\":\"Old\",\"manifest_etag\":\"etag\","
                    "\"content_count\":1,\"last_access_seq\":1}"));
    CHECK(WriteText(cache::internal::MetaPath(gid, 0),
                    "{\"status_bar_text\":\"old\",\"content_etag\":\"c\",\"image_etag\":\"img\","
                    "\"audio_etag\":\"aud\",\"width\":400,\"height\":300,\"byte_length\":15000}"));

    cache::ManifestMeta manifest;
    cache::FrameMeta frame;
    CHECK(!cache::ReadManifestMeta(gid, manifest));
    CHECK(!cache::ReadFrameMeta(gid, 0, frame));
    CHECK(!cache::FrameImageExists(gid, 0, "img", TestDisplay()));
}

void TestAudioOnlyCacheWriterPersistsIdentityAndCommits() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid, 0, "img-old", "", 0x11, 0x00);
    CHECK(cache::WriteManifest(gid, "manifest-old", 1, "Old", TestDisplay()));

    cache::CacheWriter writer(gid);
    CHECK(writer.Begin());
    CHECK(writer.FrameImageExists(0, "img-old", TestDisplay()));
    std::vector<uint8_t> audio{1, 2, 3, 4};
    CHECK(writer.WriteFrameAudio(0, audio, "aud-new", TestDisplay().profile_id, TestDisplay().frame));
    CHECK(writer.FrameAudioExists(0, "aud-new", TestDisplay()));
    CHECK(writer.WriteFrameMeta(0, MakeMeta("new", "content-new", "img-old", "aud-new")));
    CHECK(writer.CommitFrame(0, "img-old", "aud-new", TestDisplay()));
    CHECK(writer.CommitManifest("manifest-new", 1, "New", TestDisplay()));
    CHECK(cache::WriteStateMeta(gid, "manifest-new"));
    CHECK(writer.Commit());

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.audio_etag == "aud-new");
    CHECK(cache::FrameAudioExists(gid, 0, "aud-new", TestDisplay()));
    CHECK(!Exists(cache::internal::MetaPath(gid, 0) + ".bak"));
    CHECK(!Exists(cache::internal::ManifestPath(gid) + ".bak"));
}

void TestFrameManifestStateFailureRollsBackInstalledSwaps() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid, 0, "img-old", "aud-old", 0x11, 0x22);
    CHECK(cache::WriteManifest(gid, "manifest-old", 1, "Old", TestDisplay()));
    CHECK(cache::WriteStateMeta("old-selected", "manifest-old"));

    cache::CacheWriter writer(gid);
    CHECK(writer.Begin());
    std::vector<uint8_t> image(TestDisplay().frame.byte_size, 0x33);
    std::vector<uint8_t> audio{9, 8, 7};
    CHECK(writer.WriteFrameImage(0, image, "img-new", TestDisplay().profile_id, TestDisplay().frame));
    CHECK(writer.WriteFrameAudio(0, audio, "aud-new", TestDisplay().profile_id, TestDisplay().frame));
    CHECK(writer.WriteFrameMeta(0, MakeMeta("new", "content-new", "img-new", "aud-new")));
    CHECK(writer.CommitFrame(0, "img-new", "aud-new", TestDisplay()));
    CHECK(writer.CommitManifest("manifest-new", 1, "New", TestDisplay()));

    unlink(cache::internal::StatePath().c_str());
    CHECK(mkdir(cache::internal::StatePath().c_str(), 0775) == 0);
    CHECK(!cache::WriteStateMeta(gid, "manifest-new"));
    writer.Rollback();
    rmdir(cache::internal::StatePath().c_str());

    cache::FrameMeta meta;
    cache::ManifestMeta manifest;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.image_etag == "img-old");
    CHECK(meta.audio_etag == "aud-old");
    CHECK(cache::ReadManifestMeta(gid, manifest));
    CHECK(manifest.manifest_etag == "manifest-old");
    CHECK(ReadText(cache::internal::ImagePath(gid, 0)).size() == TestDisplay().frame.byte_size);
    CHECK(static_cast<unsigned char>(ReadText(cache::internal::ImagePath(gid, 0))[0]) == 0x11);
}

void TestFrameAudioDeleteFailureRollsBackInstalledSwaps() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid, 0, "img-old", "aud-old", 0x11, 0x22);
    CHECK(cache::WriteManifest(gid, "manifest-old", 1, "Old", TestDisplay()));
    CHECK(cache::WriteStateMeta("old-selected", "manifest-old"));

    cache::CacheWriter writer(gid);
    CHECK(writer.Begin());
    CHECK(writer.DeleteFrameAudio(0));
    CHECK(writer.WriteFrameMeta(0, MakeMeta("new", "content-new", "img-old", "")));
    CHECK(writer.CommitFrame(0, "img-old", "", TestDisplay()));
    CHECK(writer.CommitManifest("manifest-new", 1, "New", TestDisplay()));

    unlink(cache::internal::StatePath().c_str());
    CHECK(mkdir(cache::internal::StatePath().c_str(), 0775) == 0);
    CHECK(!cache::WriteStateMeta(gid, "manifest-new"));
    writer.Rollback();
    rmdir(cache::internal::StatePath().c_str());

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.audio_etag == "aud-old");
    CHECK(cache::FrameAudioExists(gid, 0, "aud-old", TestDisplay()));
    const std::string audio = ReadText(cache::internal::AudioPath(gid, 0));
    CHECK(audio.size() == 4);
    if (!audio.empty())
        CHECK(static_cast<unsigned char>(audio[0]) == 0x22);
}

void TestFrameManifestStateSuccessFinalizesBackups() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid, 0, "img-old", "aud-old", 0x11, 0x22);
    CHECK(cache::WriteManifest(gid, "manifest-old", 1, "Old", TestDisplay()));

    cache::CacheWriter writer(gid);
    CHECK(writer.Begin());
    std::vector<uint8_t> image(TestDisplay().frame.byte_size, 0x44);
    std::vector<uint8_t> audio{5, 6, 7};
    CHECK(writer.WriteFrameImage(0, image, "img-new", TestDisplay().profile_id, TestDisplay().frame));
    CHECK(writer.WriteFrameAudio(0, audio, "aud-new", TestDisplay().profile_id, TestDisplay().frame));
    CHECK(writer.WriteFrameMeta(0, MakeMeta("new", "content-new", "img-new", "aud-new")));
    CHECK(writer.CommitFrame(0, "img-new", "aud-new", TestDisplay()));
    CHECK(writer.CommitManifest("manifest-new", 1, "New", TestDisplay()));
    CHECK(cache::WriteStateMeta(gid, "manifest-new"));
    CHECK(writer.Commit());

    cache::FrameMeta meta;
    cache::ManifestMeta manifest;
    std::string selected;
    std::string etag;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.image_etag == "img-new");
    CHECK(meta.audio_etag == "aud-new");
    CHECK(cache::ReadManifestMeta(gid, manifest));
    CHECK(manifest.manifest_etag == "manifest-new");
    CHECK(cache::ReadStateMeta(selected, etag));
    CHECK(selected == gid);
    CHECK(etag == "manifest-new");
    CHECK(!Exists(cache::internal::ImagePath(gid, 0) + ".bak"));
    CHECK(!Exists(cache::internal::AudioPath(gid, 0) + ".bak"));
    CHECK(!Exists(cache::internal::MetaPath(gid, 0) + ".bak"));
    CHECK(!Exists(cache::internal::ManifestPath(gid) + ".bak"));
}

void TestFrameAudioDeleteSuccessFinalizesBackups() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid, 0, "img-old", "aud-old", 0x11, 0x22);
    CHECK(cache::WriteManifest(gid, "manifest-old", 1, "Old", TestDisplay()));

    cache::CacheWriter writer(gid);
    CHECK(writer.Begin());
    CHECK(writer.DeleteFrameAudio(0));
    CHECK(writer.WriteFrameMeta(0, MakeMeta("new", "content-new", "img-old", "")));
    CHECK(writer.CommitFrame(0, "img-old", "", TestDisplay()));
    CHECK(writer.CommitManifest("manifest-new", 1, "New", TestDisplay()));
    CHECK(cache::WriteStateMeta(gid, "manifest-new"));
    CHECK(writer.Commit());

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.audio_etag.empty());
    CHECK(!cache::FrameAudioExists(gid, 0, "aud-old", TestDisplay()));
    CHECK(!Exists(cache::internal::AudioPath(gid, 0)));
    CHECK(!Exists(cache::internal::AudioPath(gid, 0) + ".bak"));
    CHECK(!Exists(cache::internal::MetaPath(gid, 0) + ".bak"));
}

}  // namespace

int main() {
    TestCjsonBoundedNumberParsing();
    TestIdentitylessManifestAndFrameMetadataInvalidate();
    TestAudioOnlyCacheWriterPersistsIdentityAndCommits();
    TestFrameManifestStateFailureRollsBackInstalledSwaps();
    TestFrameAudioDeleteFailureRollsBackInstalledSwaps();
    TestFrameManifestStateSuccessFinalizesBackups();
    TestFrameAudioDeleteSuccessFinalizesBackups();
    return g_failures == 0 ? 0 : 1;
}
