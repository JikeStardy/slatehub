#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <cstdint>
#include <string>

#include "drivers/display/display_contract.h"

namespace cache::internal {

SemaphoreHandle_t StateMutex();

void ResetStateCache();
bool NextCacheAccessSeq(uint32_t& out);
bool WriteStagedStateMetaFile(const std::string& path, const std::string& selected_group_id,
                              const std::string& etag);
bool WriteManifestFile(const std::string& path, const std::string& gid, const std::string& manifest_etag,
                       int content_count, const std::string& name, uint32_t last_access_seq,
                       const display::DisplayInfo& display_info);

}  // namespace cache::internal
