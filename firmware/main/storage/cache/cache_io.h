#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "bsp/config.h"

namespace cache::internal {

inline constexpr char kTag[]                = "cache";
inline constexpr size_t kMaxAudioReadBytes    = AUDIO_MAX_PCM_BYTES;
inline constexpr size_t kMaxStateJsonBytes    = 4 * 1024;
inline constexpr size_t kMaxManifestJsonBytes = 64 * 1024;
inline constexpr size_t kMaxFrameMetaBytes    = 2 * 1024;

bool DirEnsure(const std::string& dir);
bool WriteAll(const std::string& path, const void* data, size_t len);
bool ReadAll(const std::string& path, std::vector<uint8_t>& out, size_t max_read_bytes);
bool RemoveTree(const std::string& path);
bool PathExists(const std::string& path);
bool RemoveIfExists(const std::string& path);

}  // namespace cache::internal
