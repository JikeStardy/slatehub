#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#define private public
#include "sync/sync_service.h"
#undef private

#include "power/power_state.h"
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
        struct stat       st {};
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
        std::string pattern =
            std::string((tmpdir && tmpdir[0]) ? tmpdir : "/tmp") + "/slatehub_sync_current_XXXXXX";
        std::vector<char> writable(pattern.begin(), pattern.end());
        writable.push_back('\0');
        char* path = mkdtemp(writable.data());
        if (!path)
            return;
        root_ = path;
        setenv("SLATEHUB_CACHE_ROOT", root_.c_str(), 1);
        cache::internal::ResetStateCache();
    }

    ~TempCacheRoot() {
        cache::internal::ResetStateCache();
        if (!root_.empty())
            RemoveTree(root_);
        unsetenv("SLATEHUB_CACHE_ROOT");
    }

    bool ok() const {
        return !root_.empty();
    }

   private:
    std::string root_;
};

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
    meta.content_etag    = content_etag;
    meta.image_etag      = image_etag;
    meta.audio_etag      = audio_etag;
    meta.profile_id      = TestDisplay().profile_id;
    meta.width           = TestDisplay().frame.width;
    meta.height          = TestDisplay().frame.height;
    meta.pixel_format    = "mono1";
    meta.frame_codec     = "raw_mono1_msb";
    meta.byte_length     = TestDisplay().frame.byte_size;
    return meta;
}

std::vector<uint8_t> ReadBytes(const std::string& path) {
    std::vector<uint8_t> bytes;
    cache::internal::ReadAll(path, bytes, 65536);
    return bytes;
}

void SeedCommittedFrame(const std::string& gid) {
    CHECK(cache::internal::DirEnsure(std::string(cache::internal::RootPath()) + "/groups"));
    std::vector<uint8_t> image(TestDisplay().frame.byte_size, 0x11);
    std::vector<uint8_t> audio{0x22, 0x23, 0x24};
    CHECK(cache::WriteFrameImage(gid, 0, image, "img-old", TestDisplay().frame));
    CHECK(cache::WriteFrameAudio(gid, 0, audio, "aud-old"));
    CHECK(cache::WriteFrameMeta(gid, 0, MakeMeta("old", "content-old", "img-old", "aud-old")));
}

api::ContentMeta MakeNextContent() {
    api::ContentMeta content;
    content.seq                    = 0;
    content.id                     = "content-a";
    content.content_etag           = "content-new";
    content.device_status_bar_text = "new";
    content.image_etag             = "img-new";
    content.audio_etag             = "aud-new";
    content.image_size             = static_cast<int>(TestDisplay().frame.byte_size);
    content.audio_size             = 3;
    content.frame_profile_id       = TestDisplay().profile_id;
    content.frame                  = TestDisplay().frame;
    content.variant_status         = "ready";
    return content;
}

api::ContentMeta MakeMetadataOnlyContent() {
    api::ContentMeta content;
    content.seq                    = 0;
    content.id                     = "content-a";
    content.content_etag           = "content-old";
    content.device_status_bar_text = "new-status";
    content.image_etag             = "img-old";
    content.audio_etag             = "aud-old";
    content.image_size             = static_cast<int>(TestDisplay().frame.byte_size);
    content.audio_size             = 3;
    content.frame_profile_id       = TestDisplay().profile_id;
    content.frame                  = TestDisplay().frame;
    content.variant_status         = "ready";
    return content;
}

api::ContentMeta MakeNoAudioContent() {
    api::ContentMeta content = MakeNextContent();
    content.audio_etag.clear();
    content.audio_size = 0;
    return content;
}

}  // namespace

namespace api {

namespace {
bool g_audio_download_ok = false;
int  g_image_downloads   = 0;
int  g_audio_downloads   = 0;
}  // namespace

bool DownloadContentImage(const std::string&, const std::string&, std::vector<uint8_t>& out, bool& not_modified) {
    not_modified = false;
    ++g_image_downloads;
    out.assign(TestDisplay().frame.byte_size, 0x33);
    return true;
}

bool DownloadContentAudio(const std::string&, const std::string&, std::vector<uint8_t>&, bool& not_modified) {
    not_modified = false;
    ++g_audio_downloads;
    return g_audio_download_ok;
}

bool GetManifest(const std::string&, const std::string&, Manifest&, bool&) {
    return false;
}

bool Poll(const Telemetry&, DeviceState&) {
    return false;
}

bool CycleGroup(const std::string&, DeviceState&) {
    return false;
}

bool SelectGroup(const std::string&, DeviceState&) {
    return false;
}

}  // namespace api

bool SyncService::ShouldStop() const {
    return false;
}

std::string SyncService::CurrentGroupSnapshot() const {
    return {};
}

void SyncService::SetCurrentGroup(const std::string&) {
}

void SyncService::ClearCurrentGroup() {
}

void SyncService::PostSyncedGroupReady(const std::string&, const std::string&, int, bool) {
}

void TestCurrentContentAudioFailureRollsBackDownloadedImage() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid);
    power_state::ResetHostState();
    api::g_audio_download_ok = false;
    api::g_image_downloads   = 0;
    api::g_audio_downloads   = 0;

    SyncService service;
    bool        changed = true;
    CHECK(!service.SyncCurrentContent(gid, MakeNextContent(), changed));
    CHECK(!changed);

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.content_etag == "content-old");
    CHECK(meta.image_etag == "img-old");
    CHECK(meta.audio_etag == "aud-old");
    CHECK(cache::FrameImageExists(gid, 0, "img-old", TestDisplay()));
    CHECK(cache::FrameAudioExists(gid, 0, "aud-old", TestDisplay()));
    const std::vector<uint8_t> image = ReadBytes(cache::internal::ImagePath(gid, 0));
    CHECK(image.size() == TestDisplay().frame.byte_size);
    if (!image.empty())
        CHECK(image[0] == 0x11);
    CHECK(power_state::g_set_current_frame_calls == 0);
    CHECK(api::g_image_downloads == 1);
    CHECK(api::g_audio_downloads == 1);
}

void TestCurrentContentNoAudioSuccessDeletesOldPcmAndUpdatesPowerState() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid);
    power_state::ResetHostState();
    api::g_audio_download_ok = false;
    api::g_image_downloads   = 0;
    api::g_audio_downloads   = 0;

    SyncService service;
    bool        changed = false;
    CHECK(service.SyncCurrentContent(gid, MakeNoAudioContent(), changed));
    CHECK(changed);

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.content_etag == "content-new");
    CHECK(meta.image_etag == "img-new");
    CHECK(meta.audio_etag.empty());
    CHECK(cache::FrameImageExists(gid, 0, "img-new", TestDisplay()));
    CHECK(!cache::FrameAudioExists(gid, 0, "aud-old", TestDisplay()));
    const std::vector<uint8_t> image = ReadBytes(cache::internal::ImagePath(gid, 0));
    CHECK(image.size() == TestDisplay().frame.byte_size);
    if (!image.empty())
        CHECK(image[0] == 0x33);
    CHECK(power_state::g_set_current_frame_calls == 1);
    CHECK(api::g_image_downloads == 1);
    CHECK(api::g_audio_downloads == 0);
}

void TestCurrentContentMetadataOnlyUpdatePreservesExistingAudio() {
    TempCacheRoot root;
    CHECK(root.ok());
    if (!root.ok())
        return;
    const std::string gid = "group-a";
    SeedCommittedFrame(gid);
    power_state::ResetHostState();
    api::g_audio_download_ok = false;
    api::g_image_downloads   = 0;
    api::g_audio_downloads   = 0;

    SyncService service;
    bool        changed = false;
    CHECK(service.SyncCurrentContent(gid, MakeMetadataOnlyContent(), changed));
    CHECK(changed);

    cache::FrameMeta meta;
    CHECK(cache::ReadFrameMeta(gid, 0, meta, TestDisplay()));
    CHECK(meta.status_bar_text == "new-status");
    CHECK(meta.content_etag == "content-old");
    CHECK(meta.image_etag == "img-old");
    CHECK(meta.audio_etag == "aud-old");
    CHECK(cache::FrameAudioExists(gid, 0, "aud-old", TestDisplay()));
    const std::vector<uint8_t> audio = ReadBytes(cache::internal::AudioPath(gid, 0));
    CHECK(audio.size() == 3);
    if (!audio.empty())
        CHECK(audio[0] == 0x22);
    CHECK(power_state::g_set_current_frame_calls == 1);
    CHECK(api::g_image_downloads == 0);
    CHECK(api::g_audio_downloads == 0);
}

int main() {
    TestCurrentContentAudioFailureRollsBackDownloadedImage();
    TestCurrentContentNoAudioSuccessDeletesOldPcmAndUpdatesPowerState();
    TestCurrentContentMetadataOnlyUpdatePreservesExistingAudio();
    return g_failures == 0 ? 0 : 1;
}
