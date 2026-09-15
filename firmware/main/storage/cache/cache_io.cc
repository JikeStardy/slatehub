#include "storage/cache/cache_io.h"

#include <esp_log.h>
#include <sys/stat.h>

#include <dirent.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>

namespace cache::internal {

bool DirEnsure(const std::string& dir) {
    struct stat st;
    if (stat(dir.c_str(), &st) == 0 && S_ISDIR(st.st_mode))
        return true;
    if (mkdir(dir.c_str(), 0775) == 0)
        return true;
    if (errno == EEXIST)
        return true;
    ESP_LOGW(kTag, "mkdir failed path=%s errno=%d", dir.c_str(), errno);
    return false;
}

bool WriteAll(const std::string& path, const void* data, size_t len) {
    const std::string tmp = path + ".tmp";
    FILE*             f   = fopen(tmp.c_str(), "wb");
    if (!f) {
        ESP_LOGW(kTag, "open write failed path=%s errno=%d", tmp.c_str(), errno);
        return false;
    }
    size_t w    = fwrite(data, 1, len, f);
    int    cret = fclose(f);
    if (w != len || cret != 0) {
        ESP_LOGW(kTag, "write failed path=%s written=%u expected=%u close_ret=%d", tmp.c_str(), (unsigned)w,
                 (unsigned)len, cret);
        unlink(tmp.c_str());
        return false;
    }
    if (rename(tmp.c_str(), path.c_str()) != 0) {
        ESP_LOGW(kTag, "rename failed from=%s to=%s errno=%d", tmp.c_str(), path.c_str(), errno);
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

bool ReadAll(const std::string& path, std::vector<uint8_t>& out, size_t max_read_bytes) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode))
        return false;
    const off_t len = st.st_size;
    if (len < 0)
        return false;
    if (static_cast<uint64_t>(len) > static_cast<uint64_t>(max_read_bytes)) {
        ESP_LOGW(kTag, "read refused path=%s bytes=%llu limit=%llu", path.c_str(),
                 static_cast<unsigned long long>(len), static_cast<unsigned long long>(max_read_bytes));
        return false;
    }
    FILE* f = fopen(path.c_str(), "rb");
    if (!f)
        return false;
    out.resize(static_cast<size_t>(len));
    size_t r = fread(out.data(), 1, static_cast<size_t>(len), f);
    fclose(f);
    return r == static_cast<size_t>(len);
}

namespace {
bool RemoveTreeInternal(const std::string& path, int depth) {
    constexpr int kMaxRemoveTreeDepth = 16;
    if (depth > kMaxRemoveTreeDepth) {
        ESP_LOGW(kTag, "remove tree refused reason=max_depth depth=%d path=%s", kMaxRemoveTreeDepth, path.c_str());
        return false;
    }
    DIR* dir = opendir(path.c_str());
    if (!dir)
        return errno == ENOENT;

    bool ok = true;
    while (struct dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string child = path + "/" + ent->d_name;
        struct stat       st;
        if (stat(child.c_str(), &st) != 0) {
            ok = false;
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            ok = RemoveTreeInternal(child, depth + 1) && ok;
        } else if (unlink(child.c_str()) != 0 && errno != ENOENT) {
            ESP_LOGW(kTag, "unlink failed path=%s errno=%d", child.c_str(), errno);
            ok = false;
        }
    }
    closedir(dir);
    if (rmdir(path.c_str()) != 0 && errno != ENOENT) {
        ESP_LOGW(kTag, "rmdir failed path=%s errno=%d", path.c_str(), errno);
        ok = false;
    }
    return ok;
}
}  // namespace

bool RemoveTree(const std::string& path) {
    return RemoveTreeInternal(path, 0);
}

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RemoveIfExists(const std::string& path) {
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "unlink failed path=%s errno=%d", path.c_str(), errno);
    return false;
}

}  // namespace cache::internal
