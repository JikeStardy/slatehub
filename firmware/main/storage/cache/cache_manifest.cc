#include "storage/cache/cache.h"

#include <cJSON.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <dirent.h>
#include <algorithm>
#include <cerrno>
#include <cstring>

#include "storage/cache/cache_internal.h"
#include "storage/cache/cache_io.h"
#include "storage/cache/cache_json.h"
#include "storage/cache/cache_paths.h"
#include "sync/manifest_contract.h"

namespace {

bool ReadManifestMetaFile(const std::string& path, cache::ManifestMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!cache::internal::ReadAll(path, buf, cache::internal::kMaxManifestJsonBytes))
        return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root)
        return false;
    out.gid             = cache::internal::JsonStringField(root, "group_id");
    out.name            = cache::internal::JsonStringField(root, "group_name");
    out.manifest_etag   = cache::internal::JsonStringField(root, "manifest_etag");
    out.content_count   = cache::internal::JsonNonNegativeIntField(root, "content_count", 0);
    out.last_access_seq = cache::internal::JsonUint32Field(root, "last_access_seq", 0);
    out.profile_id      = cache::internal::JsonStringField(root, "profile_id");
    out.width           = cache::internal::JsonNonNegativeIntField(root, "width", 0);
    out.height          = cache::internal::JsonNonNegativeIntField(root, "height", 0);
    out.pixel_format    = cache::internal::JsonStringField(root, "pixel_format");
    out.frame_codec     = cache::internal::JsonStringField(root, "frame_codec");
    out.byte_length     = static_cast<size_t>(cache::internal::JsonNonNegativeIntField(root, "byte_length", 0));
    cJSON_Delete(root);
    return !out.manifest_etag.empty();
}

void WriteManifestIdentity(cJSON* root, const cache::ManifestMeta& meta) {
    cJSON_AddStringToObject(root, "profile_id", meta.profile_id.c_str());
    cJSON_AddNumberToObject(root, "width", meta.width);
    cJSON_AddNumberToObject(root, "height", meta.height);
    cJSON_AddStringToObject(root, "pixel_format", meta.pixel_format.c_str());
    cJSON_AddStringToObject(root, "frame_codec", meta.frame_codec.c_str());
    cJSON_AddNumberToObject(root, "byte_length", static_cast<double>(meta.byte_length));
}

}  // namespace

namespace cache {

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count,
                   const std::string& name, const display::DisplayInfo& display_info) {
    internal::DirEnsure(std::string(internal::kRoot) + "/groups");
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    ManifestMeta old;
    ReadManifestMeta(gid, old);
    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "group_id", gid.c_str());
    cJSON_AddStringToObject(root, "group_name", name.empty() ? old.name.c_str() : name.c_str());
    cJSON_AddStringToObject(root, "manifest_etag", manifest_etag.c_str());
    cJSON_AddNumberToObject(root, "content_count", content_count);
    cJSON_AddNumberToObject(root, "last_access_seq", static_cast<double>(old.last_access_seq));
    ManifestMeta identity = old;
    identity.profile_id   = display_info.profile_id ? display_info.profile_id : "";
    identity.width        = display_info.frame.width;
    identity.height       = display_info.frame.height;
    identity.pixel_format = sync_contract::PixelFormatWire(display_info.frame.pixel_format);
    identity.frame_codec  = sync_contract::FrameCodecWire(display_info.frame.codec);
    identity.byte_length  = display_info.frame.byte_size;
    WriteManifestIdentity(root, identity);
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && internal::WriteAll(internal::ManifestPath(gid), s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool ManifestIdentityMatches(const ManifestMeta& meta, const display::DisplayInfo& display_info) {
    return meta.profile_id == (display_info.profile_id ? display_info.profile_id : "") &&
           meta.width == display_info.frame.width && meta.height == display_info.frame.height &&
           meta.pixel_format == sync_contract::PixelFormatWire(display_info.frame.pixel_format) &&
           meta.frame_codec == sync_contract::FrameCodecWire(display_info.frame.codec) &&
           meta.byte_length == display_info.frame.byte_size && display::ValidateFrameDescriptor(display_info.frame);
}

bool ReadManifestMeta(const std::string& gid, ManifestMeta& out) {
    if (!ReadManifestMetaFile(internal::ManifestPath(gid), out))
        return false;
    if (out.gid.empty())
        out.gid = gid;
    return true;
}

bool ReadManifestContentCount(const std::string& gid, int& out, const display::DisplayInfo& display_info) {
    ManifestMeta meta;
    if (!ReadManifestMeta(gid, meta))
        return false;
    if (!ManifestIdentityMatches(meta, display_info))
        return false;
    out = meta.content_count;
    return true;
}

bool TouchGroup(const std::string& gid) {
    if (gid.empty())
        return false;

    uint32_t next_seq = 1;
    if (!internal::NextCacheAccessSeq(next_seq))
        return false;

    ManifestMeta meta;
    if (!ReadManifestMeta(gid, meta))
        return false;
    meta.last_access_seq = next_seq;

    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "group_id", meta.gid.empty() ? gid.c_str() : meta.gid.c_str());
    cJSON_AddStringToObject(root, "group_name", meta.name.c_str());
    cJSON_AddStringToObject(root, "manifest_etag", meta.manifest_etag.c_str());
    cJSON_AddNumberToObject(root, "content_count", meta.content_count);
    cJSON_AddNumberToObject(root, "last_access_seq", static_cast<double>(meta.last_access_seq));
    WriteManifestIdentity(root, meta);
    char* s = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!s)
        return false;
    const bool ok = internal::WriteAll(internal::ManifestPath(gid), s, std::strlen(s));
    cJSON_free(s);
    return ok;
}

bool PruneOldGroups(const std::string& current_gid, const std::string& target_gid, size_t min_free_bytes,
                    int max_groups) {
    const std::string groups_dir  = std::string(internal::kRoot) + "/groups";
    const std::string current_dir = current_gid.empty() ? "" : internal::GroupDir(current_gid);
    const std::string target_dir  = target_gid.empty() ? "" : internal::GroupDir(target_gid);

    struct Candidate {
        std::string path;
        uint32_t    last_access_seq = 0;
    };
    std::vector<Candidate> candidates;
    int                    group_count = 0;

    DIR* dir = opendir(groups_dir.c_str());
    if (!dir)
        return errno == ENOENT;
    while (struct dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string child = groups_dir + "/" + ent->d_name;
        struct stat       st;
        if (stat(child.c_str(), &st) != 0 || !S_ISDIR(st.st_mode))
            continue;
        ++group_count;
        if (child == current_dir || child == target_dir)
            continue;
        ManifestMeta meta;
        ReadManifestMetaFile(child + "/manifest.json", meta);
        candidates.push_back({child, meta.last_access_seq});
    }
    closedir(dir);

    std::sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
        if (a.last_access_seq != b.last_access_seq)
            return a.last_access_seq < b.last_access_seq;
        return a.path < b.path;
    });

    auto free_bytes = []() -> size_t {
        size_t total = 0, used = 0;
        if (esp_littlefs_info("storage", &total, &used) != ESP_OK || total < used)
            return 0;
        return total - used;
    };

    bool ok = true;
    for (const auto& c : candidates) {
        if ((max_groups <= 0 || group_count <= max_groups) && free_bytes() >= min_free_bytes)
            break;
        ESP_LOGD(internal::kTag, "prune group path=%s", c.path.c_str());
        ok = internal::RemoveTree(c.path) && ok;
        --group_count;
    }
    return ok;
}

}  // namespace cache
