#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                 {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {group_id, group_name, manifest_etag, content_count, last_access_seq}
//   /littlefs/groups/{gid}/frames/{idx}.img  descriptor-defined raw frame bytes
//   /littlefs/groups/{gid}/frames/{idx}.pcm  16k mono raw PCM

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "drivers/display/display_contract.h"
#include "storage/cache/cache_staging.h"

namespace cache {

bool Init();
bool FormatAll();

bool        ReadStateMeta(std::string& selected_group_id, std::string& last_etag);
bool        WriteStateMeta(const std::string& selected_group_id, const std::string& etag);
std::string ReadCurrentManifestEtag(const display::DisplayInfo& display_info);
bool        ReadCurrentFrameSeq(int& out);
bool        WriteCurrentFrameSeq(int seq);

struct CachedGroupSummary {
    std::string gid;
    std::string name;
    std::string manifest_etag;
    int         content_count = 0;
};
bool ReadCachedGroupSummary(CachedGroupSummary& out, const display::DisplayInfo& display_info);

struct ManifestMeta {
    std::string gid;
    std::string name;
    std::string manifest_etag;
    int         content_count   = 0;
    uint32_t    last_access_seq = 0;
    std::string profile_id;
    int         width           = 0;
    int         height          = 0;
    std::string pixel_format;
    std::string frame_codec;
    size_t      byte_length     = 0;
};

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count,
                   const std::string& name, const display::DisplayInfo& display_info);
bool ReadManifestMeta(const std::string& gid, ManifestMeta& out);
bool ReadManifestContentCount(const std::string& gid, int& out, const display::DisplayInfo& display_info);
bool ManifestIdentityMatches(const ManifestMeta& meta, const display::DisplayInfo& display_info);
bool TouchGroup(const std::string& gid);
bool PruneOldGroups(const std::string& current_gid, const std::string& target_gid, size_t min_free_bytes,
                    int max_groups);

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag,
                      const display::DisplayInfo& display_info);
bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                     const display::FrameDescriptor& descriptor);
bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out,
                    const display::DisplayInfo& display_info);

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag,
                      const display::DisplayInfo& display_info);
bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out);
void DeleteFrameAudio(const std::string& gid, int idx);
void DeleteFrameFiles(const std::string& gid, int idx);

struct FrameMeta {
    std::string status_bar_text;
    std::string content_etag;
    std::string image_etag;
    std::string audio_etag;
    bool        has_ttl = false;
    uint32_t    ttl_sec = 0;
    std::string profile_id;
    int         width       = 0;
    int         height      = 0;
    std::string pixel_format;
    std::string frame_codec;
    size_t      byte_length = 0;
};
bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta);
bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out);
bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out, const display::DisplayInfo& display_info);

class CacheWriter {
   public:
    explicit CacheWriter(std::string gid);
    ~CacheWriter();

    CacheWriter(const CacheWriter&)            = delete;
    CacheWriter& operator=(const CacheWriter&) = delete;

    bool Begin();
    bool FrameImageExists(int idx, const std::string& expected_etag, const display::DisplayInfo& display_info) const;
    bool WriteFrameImage(int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                         const std::string& profile_id, const display::FrameDescriptor& descriptor);
    bool FrameAudioExists(int idx, const std::string& expected_etag, const display::DisplayInfo& display_info) const;
    bool WriteFrameAudio(int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                         const std::string& profile_id, const display::FrameDescriptor& descriptor);
    bool DeleteFrameAudio(int idx);
    bool WriteFrameMeta(int idx, const FrameMeta& meta);
    bool CommitFrame(int idx, const std::string& image_etag, const std::string& audio_etag,
                     const display::DisplayInfo& display_info);
    bool CommitManifest(const std::string& manifest_etag, int content_count, const std::string& name,
                        const display::DisplayInfo& display_info);
    bool CommitStateMeta(const std::string& selected_group_id, const std::string& etag);
    bool Commit();
    bool Rollback();

   private:
    std::string gid_;
    std::vector<staging::Swap> swaps_;
    bool                       begun_     = false;
    bool                       committed_ = false;
};

}  // namespace cache
