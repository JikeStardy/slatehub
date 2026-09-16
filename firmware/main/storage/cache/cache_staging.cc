#include "storage/cache/cache_staging.h"

#include <esp_log.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>

namespace cache::staging {
namespace {

constexpr char kTag[] = "cache_stage";

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RenameReplace(const std::string& from, const std::string& to) {
    if (rename(from.c_str(), to.c_str()) == 0)
        return true;
    ESP_LOGW(kTag, "rename failed from=%s to=%s errno=%d", from.c_str(), to.c_str(), errno);
    return false;
}

bool RemoveIfExists(const std::string& path) {
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "unlink failed path=%s errno=%d", path.c_str(), errno);
    return false;
}

}  // namespace

bool RollbackSwaps(std::vector<Swap>& swaps) {
    bool ok = true;
    for (auto it = swaps.rbegin(); it != swaps.rend(); ++it) {
        if (it->installed) {
            if (rename(it->target.c_str(), it->staged.c_str()) != 0 && errno != ENOENT) {
                ESP_LOGW(kTag, "rollback move failed from=%s to=%s errno=%d", it->target.c_str(), it->staged.c_str(),
                         errno);
                ok = RemoveIfExists(it->target) && ok;
            }
            it->installed = false;
        }
        if (it->had_target) {
            if (rename(it->backup.c_str(), it->target.c_str()) != 0) {
                ESP_LOGE(kTag, "rollback restore failed from=%s to=%s errno=%d", it->backup.c_str(), it->target.c_str(),
                         errno);
                ok = false;
            }
            it->had_target = false;
        } else {
            ok = RemoveIfExists(it->backup) && ok;
        }
    }
    return ok;
}

bool InstallSwaps(std::vector<Swap>& swaps) {
    for (auto& swap : swaps) {
        if (swap.installed)
            continue;
        if (!RemoveIfExists(swap.backup)) {
            RollbackSwaps(swaps);
            return false;
        }
        if (PathExists(swap.target)) {
            if (!RenameReplace(swap.target, swap.backup)) {
                RollbackSwaps(swaps);
                return false;
            }
            swap.had_target = true;
        }
        if (swap.delete_target) {
            if (!RemoveIfExists(swap.target)) {
                RollbackSwaps(swaps);
                return false;
            }
            swap.installed = true;
            continue;
        }
        if (!RenameReplace(swap.staged, swap.target)) {
            if (swap.had_target) {
                if (RenameReplace(swap.backup, swap.target)) {
                    swap.had_target = false;
                } else {
                    ESP_LOGE(kTag, "stage restore failed target=%s", swap.target.c_str());
                }
            }
            RollbackSwaps(swaps);
            return false;
        }
        swap.installed = true;
    }
    return true;
}

bool FinalizeSwaps(std::vector<Swap>& swaps) {
    bool ok = true;
    for (auto& swap : swaps) {
        if (swap.had_target)
            ok = RemoveIfExists(swap.backup) && ok;
        swap.had_target = false;
        swap.installed  = false;
    }
    return ok;
}

bool CommitSwaps(std::vector<Swap>& swaps) {
    if (!InstallSwaps(swaps))
        return false;
    return FinalizeSwaps(swaps);
}

}  // namespace cache::staging
