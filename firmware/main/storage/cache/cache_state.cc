#include "storage/cache/cache.h"

#include <cJSON.h>
#include <cstring>

#include "storage/cache/cache_internal.h"
#include "storage/cache/cache_io.h"
#include "storage/cache/cache_json.h"
#include "storage/cache/cache_paths.h"
#include "utils/scoped_mutex_lock.h"

namespace cache::internal {
namespace {

struct StateJson {
    cJSON* root = nullptr;

    StateJson() = default;
    ~StateJson() {
        if (root)
            cJSON_Delete(root);
    }

    StateJson(const StateJson&)            = delete;
    StateJson& operator=(const StateJson&) = delete;
    StateJson(StateJson&& other) noexcept : root(other.root) {
        other.root = nullptr;
    }
    StateJson& operator=(StateJson&& other) noexcept {
        if (this != &other) {
            if (root)
                cJSON_Delete(root);
            root       = other.root;
            other.root = nullptr;
        }
        return *this;
    }
};

struct StateCache {
    bool        loaded = false;
    bool        exists = false;
    std::string selected_group_id;
    std::string last_etag;
    int         current_frame_seq = 0;
    uint32_t    cache_access_seq  = 0;
};

StateCache& StateCacheUnlocked() {
    static StateCache s_cache;
    return s_cache;
}

StateJson ReadStateJsonUnlocked() {
    StateJson            state;
    std::vector<uint8_t> buf;
    if (!ReadAll(StatePath(), buf, kMaxStateJsonBytes))
        return state;
    state.root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    return state;
}

void ResetStateCacheUnlocked() {
    auto& cache             = StateCacheUnlocked();
    cache.loaded            = false;
    cache.exists            = false;
    cache.selected_group_id = "";
    cache.last_etag         = "";
    cache.current_frame_seq = 0;
    cache.cache_access_seq  = 0;
}

bool WriteStateJsonUnlocked(const std::string& selected_group_id, const std::string& etag, int current_frame_seq,
                            uint32_t cache_access_seq) {
    if (current_frame_seq < 0)
        current_frame_seq = 0;

    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "selected_group_id", selected_group_id.c_str());
    cJSON_AddStringToObject(root, "last_etag", etag.c_str());
    cJSON_AddNumberToObject(root, "current_frame_seq", current_frame_seq);
    cJSON_AddNumberToObject(root, "cache_access_seq", static_cast<double>(cache_access_seq));
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(StatePath(), s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool LoadStateCacheUnlocked() {
    auto& cache = StateCacheUnlocked();
    if (cache.loaded)
        return cache.exists;

    StateJson state = ReadStateJsonUnlocked();
    cache.loaded    = true;
    if (!state.root) {
        cache.exists            = false;
        cache.selected_group_id = "";
        cache.last_etag         = "";
        cache.current_frame_seq = 0;
        cache.cache_access_seq  = 0;
        return false;
    }

    cache.exists            = true;
    cache.selected_group_id = JsonStringField(state.root, "selected_group_id");
    cache.last_etag         = JsonStringField(state.root, "last_etag");
    cache.current_frame_seq = JsonNonNegativeIntField(state.root, "current_frame_seq", 0);
    cache.cache_access_seq  = JsonUint32Field(state.root, "cache_access_seq", 0);
    return true;
}

bool PersistStateCacheUnlocked() {
    auto& cache  = StateCacheUnlocked();
    cache.loaded = true;
    cache.exists = true;
    return WriteStateJsonUnlocked(cache.selected_group_id, cache.last_etag, cache.current_frame_seq,
                                  cache.cache_access_seq);
}

}  // namespace

void ResetStateCache() {
    ScopedMutexLock lock(StateMutex());
    if (lock.locked())
        ResetStateCacheUnlocked();
}

bool NextCacheAccessSeq(uint32_t& out) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    LoadStateCacheUnlocked();
    auto& cache            = StateCacheUnlocked();
    const StateCache old   = cache;
    out                    = cache.cache_access_seq == UINT32_MAX ? UINT32_MAX : cache.cache_access_seq + 1;
    cache.cache_access_seq = out;
    if (!PersistStateCacheUnlocked()) {
        cache = old;
        return false;
    }
    return true;
}

}  // namespace cache::internal

namespace cache {

bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag) {
    ScopedMutexLock lock(internal::StateMutex());
    if (!lock.locked())
        return false;
    if (!internal::LoadStateCacheUnlocked())
        return false;
    const auto& cache = internal::StateCacheUnlocked();
    selected_group_id = cache.selected_group_id;
    last_etag         = cache.last_etag;
    return true;
}

bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag) {
    ScopedMutexLock lock(internal::StateMutex());
    if (!lock.locked())
        return false;
    internal::LoadStateCacheUnlocked();
    auto& cache             = internal::StateCacheUnlocked();
    const auto old          = cache;
    cache.selected_group_id = selected_group_id;
    cache.last_etag         = etag;
    if (!internal::PersistStateCacheUnlocked()) {
        cache = old;
        return false;
    }
    return true;
}

std::string ReadCurrentManifestEtag(const display::DisplayInfo& display_info) {
    ScopedMutexLock lock(internal::StateMutex());
    if (!lock.locked())
        return "";
    if (!internal::LoadStateCacheUnlocked())
        return "";
    const auto& cache = internal::StateCacheUnlocked();
    if (cache.selected_group_id.empty())
        return "";
    ManifestMeta meta;
    if (!ReadManifestMeta(cache.selected_group_id, meta) || !ManifestIdentityMatches(meta, display_info))
        return "";
    return cache.last_etag;
}

bool ReadCurrentFrameSeq(int& out) {
    out = 0;
    ScopedMutexLock lock(internal::StateMutex());
    if (!lock.locked())
        return false;
    if (!internal::LoadStateCacheUnlocked())
        return false;
    out = internal::StateCacheUnlocked().current_frame_seq;
    return true;
}

bool WriteCurrentFrameSeq(int seq) {
    ScopedMutexLock lock(internal::StateMutex());
    if (!lock.locked())
        return false;
    internal::LoadStateCacheUnlocked();
    auto& cache             = internal::StateCacheUnlocked();
    const auto old          = cache;
    cache.current_frame_seq = seq < 0 ? 0 : seq;
    if (!internal::PersistStateCacheUnlocked()) {
        cache = old;
        return false;
    }
    return true;
}

bool ReadCachedGroupSummary(CachedGroupSummary& out, const display::DisplayInfo& display_info) {
    out = {};
    if (!ReadStateMeta(out.gid, out.manifest_etag) || out.gid.empty())
        return false;
    ManifestMeta meta;
    if (!ReadManifestMeta(out.gid, meta) || !ManifestIdentityMatches(meta, display_info)) {
        out = {};
        return false;
    }
    out.name          = meta.name;
    out.manifest_etag = meta.manifest_etag;
    out.content_count = meta.content_count;
    return true;
}

}  // namespace cache
