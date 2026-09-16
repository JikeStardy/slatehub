#include "storage/cache/cache.h"

#include <esp_littlefs.h>
#include <esp_log.h>

#include "storage/cache/cache_internal.h"
#include "storage/cache/cache_io.h"
#include "storage/cache/cache_paths.h"
#include "storage/cache/cache_staging.h"

#include <dirent.h>
#include <cstring>

namespace {

bool RecoverStagedTransactions() {
    const std::string groups_dir = std::string(cache::internal::RootPath()) + "/groups";
    DIR*              dir        = opendir(groups_dir.c_str());
    if (!dir)
        return true;

    bool ok = true;
    while (struct dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string gid          = ent->d_name;
        const std::string stage_dir    = groups_dir + "/" + gid + "/stage";
        const std::string journal_path = stage_dir + "/transaction.journal";
        bool              recovered    = true;
        if (cache::internal::PathExists(journal_path)) {
            recovered = cache::staging::RecoverJournal(journal_path);
            ok        = recovered && ok;
        }
        if (recovered)
            ok = cache::internal::RemoveTree(stage_dir) && ok;
    }
    closedir(dir);
    return ok;
}

}  // namespace

namespace cache {

bool Init() {
    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path               = internal::RootPath();
    cfg.partition_label         = "storage";
    cfg.format_if_mount_failed  = true;
    cfg.dont_mount              = false;

    esp_err_t err = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(internal::kTag, "littlefs mount failed err=%s", esp_err_to_name(err));
        return false;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(cfg.partition_label, &total, &used);
    internal::DirEnsure(std::string(internal::RootPath()) + "/groups");
    if (!RecoverStagedTransactions()) {
        ESP_LOGE(internal::kTag, "cache recovery failed action=abort_init");
        return false;
    }
    return true;
}

bool FormatAll() {
    constexpr char kLabel[] = "storage";
    ESP_LOGW(internal::kTag, "format all action=erase_littlefs_cache");
    esp_err_t err = esp_vfs_littlefs_unregister(kLabel);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(internal::kTag, "littlefs unregister failed err=%s action=continue", esp_err_to_name(err));
    }
    err = esp_littlefs_format(kLabel);
    if (err != ESP_OK) {
        ESP_LOGE(internal::kTag, "littlefs format failed err=%s", esp_err_to_name(err));
        return false;
    }

    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path               = internal::RootPath();
    cfg.partition_label         = kLabel;
    cfg.format_if_mount_failed  = true;
    cfg.dont_mount              = false;
    err                         = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(internal::kTag, "littlefs remount failed err=%s", esp_err_to_name(err));
        return false;
    }
    internal::ResetStateCache();
    internal::DirEnsure(std::string(internal::RootPath()) + "/groups");
    return true;
}

}  // namespace cache
