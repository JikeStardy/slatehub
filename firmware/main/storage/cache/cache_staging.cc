#include "storage/cache/cache_staging.h"

#include <esp_log.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string_view>

namespace cache::staging {
namespace {

constexpr char kTag[] = "cache_stage";
constexpr char kJournalMagic[] = "slate-cache-stage-v1";
constexpr std::size_t kMaxJournalLineBytes = 2048;

#ifdef SLATE_HOST_TEST
std::string g_fail_rename_from;
std::string g_fail_rename_to;
std::string g_fail_unlink_path;
#endif

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RenameReplace(const std::string& from, const std::string& to) {
#ifdef SLATE_HOST_TEST
    if (from == g_fail_rename_from && to == g_fail_rename_to) {
        g_fail_rename_from.clear();
        g_fail_rename_to.clear();
        errno = EIO;
        ESP_LOGW(kTag, "rename failed by test hook from=%s to=%s", from.c_str(), to.c_str());
        return false;
    }
#endif
    if (rename(from.c_str(), to.c_str()) == 0)
        return true;
    ESP_LOGW(kTag, "rename failed from=%s to=%s errno=%d", from.c_str(), to.c_str(), errno);
    return false;
}

bool RemoveIfExists(const std::string& path) {
#ifdef SLATE_HOST_TEST
    if (path == g_fail_unlink_path) {
        g_fail_unlink_path.clear();
        errno = EIO;
        ESP_LOGW(kTag, "unlink failed by test hook path=%s", path.c_str());
        return false;
    }
#endif
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "unlink failed path=%s errno=%d", path.c_str(), errno);
    return false;
}

std::string BoolWire(bool value) {
    return value ? "1" : "0";
}

bool ParseBoolWire(const char* value, bool& out) {
    if (std::strcmp(value, "0") == 0) {
        out = false;
        return true;
    }
    if (std::strcmp(value, "1") == 0) {
        out = true;
        return true;
    }
    return false;
}

std::string EscapeField(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());
    for (unsigned char ch : raw) {
        if (ch == '%' || ch == '\t' || ch == '\n' || ch == '\r') {
            static constexpr char kHex[] = "0123456789ABCDEF";
            out.push_back('%');
            out.push_back(kHex[ch >> 4]);
            out.push_back(kHex[ch & 0x0F]);
        } else {
            out.push_back(static_cast<char>(ch));
        }
    }
    return out;
}

bool HexValue(char ch, unsigned char& out) {
    if (ch >= '0' && ch <= '9') {
        out = static_cast<unsigned char>(ch - '0');
        return true;
    }
    if (ch >= 'A' && ch <= 'F') {
        out = static_cast<unsigned char>(ch - 'A' + 10);
        return true;
    }
    return false;
}

bool UnescapeField(std::string_view raw, std::string& out) {
    out.clear();
    for (std::size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] != '%') {
            out.push_back(raw[i]);
            continue;
        }
        if (i + 2 >= raw.size())
            return false;
        unsigned char hi = 0;
        unsigned char lo = 0;
        if (!HexValue(raw[i + 1], hi) || !HexValue(raw[i + 2], lo))
            return false;
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
    }
    return true;
}

bool ReadJournal(const std::string& journal_path, std::vector<Swap>& swaps) {
    FILE* f = std::fopen(journal_path.c_str(), "rb");
    if (!f)
        return false;

    char line[kMaxJournalLineBytes] = {};
    if (!std::fgets(line, sizeof(line), f)) {
        std::fclose(f);
        return false;
    }
    if (!std::strchr(line, '\n') && !std::feof(f)) {
        std::fclose(f);
        return false;
    }
    line[std::strcspn(line, "\r\n")] = '\0';
    if (std::strcmp(line, kJournalMagic) != 0) {
        std::fclose(f);
        return false;
    }

    swaps.clear();
    while (std::fgets(line, sizeof(line), f)) {
        if (!std::strchr(line, '\n') && !std::feof(f)) {
            std::fclose(f);
            swaps.clear();
            return false;
        }
        line[std::strcspn(line, "\r\n")] = '\0';
        const char* fields[5]            = {};
        int         field_count          = 0;
        char*       cursor               = line;
        while (field_count < 5) {
            fields[field_count++] = cursor;
            char* tab            = std::strchr(cursor, '\t');
            if (!tab)
                break;
            *tab   = '\0';
            cursor = tab + 1;
        }
        if (field_count != 5) {
            std::fclose(f);
            swaps.clear();
            return false;
        }
        Swap swap;
        bool target_existed = false;
        bool delete_target  = false;
        if (!UnescapeField(fields[0], swap.staged) || !UnescapeField(fields[1], swap.target) ||
            !UnescapeField(fields[2], swap.backup) || !ParseBoolWire(fields[3], target_existed) ||
            !ParseBoolWire(fields[4], delete_target) || swap.target.empty() || swap.backup.empty()) {
            std::fclose(f);
            swaps.clear();
            return false;
        }
        swap.target_existed = target_existed;
        swap.delete_target  = delete_target;
        swaps.push_back(swap);
    }

    const bool ok = std::ferror(f) == 0;
    std::fclose(f);
    if (!ok)
        swaps.clear();
    return ok;
}

}  // namespace

bool RollbackSwaps(std::vector<Swap>& swaps) {
    bool ok = true;
    for (auto it = swaps.rbegin(); it != swaps.rend(); ++it) {
        if (it->installed) {
            if (RenameReplace(it->target, it->staged)) {
                it->installed = false;
            } else if (errno == ENOENT) {
                it->installed = false;
            } else {
                ESP_LOGW(kTag, "rollback move failed from=%s to=%s errno=%d", it->target.c_str(),
                         it->staged.c_str(), errno);
                if (RemoveIfExists(it->target)) {
                    it->installed = false;
                } else {
                    ok = false;
                    continue;
                }
            }
        }
        if (it->had_target) {
            if (RenameReplace(it->backup, it->target)) {
                it->had_target = false;
            } else {
                ESP_LOGE(kTag, "rollback restore failed from=%s to=%s errno=%d", it->backup.c_str(), it->target.c_str(),
                         errno);
                ok = false;
            }
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
        if (!RemoveIfExists(swap.backup))
            return false;
        if (PathExists(swap.target)) {
            if (!RenameReplace(swap.target, swap.backup))
                return false;
            swap.had_target = true;
        }
        if (swap.delete_target) {
            if (!RemoveIfExists(swap.target))
                return false;
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
    if (!InstallSwaps(swaps)) {
        RollbackSwaps(swaps);
        return false;
    }
    return FinalizeSwaps(swaps);
}

bool WriteJournal(const std::string& journal_path, const std::vector<Swap>& swaps) {
    const std::string tmp = journal_path + ".tmp";
    FILE*             f   = std::fopen(tmp.c_str(), "wb");
    if (!f) {
        ESP_LOGW(kTag, "journal open failed path=%s errno=%d", tmp.c_str(), errno);
        return false;
    }
    bool ok = std::fprintf(f, "%s\n", kJournalMagic) > 0;
    for (const auto& swap : swaps) {
        ok = ok && std::fprintf(f, "%s\t%s\t%s\t%s\t%s\n", EscapeField(swap.staged).c_str(),
                                EscapeField(swap.target).c_str(), EscapeField(swap.backup).c_str(),
                                BoolWire(swap.target_existed).c_str(),
                                BoolWire(swap.delete_target).c_str()) > 0;
    }
    if (std::fflush(f) != 0 || fsync(fileno(f)) != 0)
        ok = false;
    if (std::fclose(f) != 0)
        ok = false;
    if (!ok) {
        ESP_LOGW(kTag, "journal write failed path=%s errno=%d", tmp.c_str(), errno);
        RemoveIfExists(tmp);
        return false;
    }
    if (!RenameReplace(tmp, journal_path)) {
        RemoveIfExists(tmp);
        return false;
    }
    return true;
}

bool RemoveJournal(const std::string& journal_path) {
    return RemoveIfExists(journal_path + ".tmp") && RemoveIfExists(journal_path);
}

bool RecoverJournal(const std::string& journal_path) {
    std::vector<Swap> swaps;
    if (!ReadJournal(journal_path, swaps)) {
        ESP_LOGW(kTag, "journal read failed path=%s action=keep", journal_path.c_str());
        return false;
    }

    bool ok = true;
    for (auto it = swaps.rbegin(); it != swaps.rend(); ++it) {
        if (PathExists(it->backup)) {
            ok = RemoveIfExists(it->target) && ok;
            if (!RenameReplace(it->backup, it->target))
                ok = false;
        } else if (!it->delete_target && !it->target_existed && !PathExists(it->staged)) {
            ok = RemoveIfExists(it->target) && ok;
        }
    }
    if (ok)
        ok = RemoveJournal(journal_path);
    return ok;
}

#ifdef SLATE_HOST_TEST
void TestFailNextRename(const std::string& from, const std::string& to) {
    g_fail_rename_from = from;
    g_fail_rename_to   = to;
}

void TestFailNextUnlink(const std::string& path) {
    g_fail_unlink_path = path;
}
#endif

}  // namespace cache::staging
