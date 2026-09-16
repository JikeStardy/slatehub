#include "storage/cache/cache.h"

#include <cJSON.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <unistd.h>
#include <cstdint>
#include <cstring>
#include <utility>

#include "storage/cache/cache_internal.h"
#include "storage/cache/cache_io.h"
#include "storage/cache/cache_paths.h"
#include "storage/cache/cache_staging.h"
#include "sync/manifest_contract.h"

namespace {

bool StatSizeEqualsDescriptor(const struct stat& st, const display::FrameDescriptor& descriptor) {
    if (st.st_size < 0 || !display::ValidateFrameDescriptor(descriptor))
        return false;
    return static_cast<uint64_t>(st.st_size) == static_cast<uint64_t>(descriptor.byte_size);
}

bool WriteFrameMetaFile(const std::string& path, const cache::FrameMeta& meta) {
    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "status_bar_text", meta.status_bar_text.c_str());
    cJSON_AddStringToObject(root, "content_etag", meta.content_etag.c_str());
    cJSON_AddStringToObject(root, "image_etag", meta.image_etag.c_str());
    cJSON_AddStringToObject(root, "audio_etag", meta.audio_etag.c_str());
    cJSON_AddStringToObject(root, "profile_id", meta.profile_id.c_str());
    cJSON_AddNumberToObject(root, "width", meta.width);
    cJSON_AddNumberToObject(root, "height", meta.height);
    cJSON_AddStringToObject(root, "pixel_format", meta.pixel_format.c_str());
    cJSON_AddStringToObject(root, "frame_codec", meta.frame_codec.c_str());
    cJSON_AddNumberToObject(root, "byte_length", static_cast<double>(meta.byte_length));
    if (meta.has_ttl) {
        cJSON_AddNumberToObject(root, "ttl_sec", static_cast<double>(meta.ttl_sec));
    } else {
        cJSON_AddNullToObject(root, "ttl_sec");
    }
    char* s = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!s)
        return false;
    const size_t len = std::strlen(s);
    const bool   ok  = cache::internal::WriteAll(path, s, len);
    cJSON_free(s);
    return ok;
}

bool ReadFrameMetaFile(const std::string& path, cache::FrameMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!cache::internal::ReadAll(path, buf, cache::internal::kMaxFrameMetaBytes) || buf.empty())
        return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root)
        return false;
    cJSON* cap        = cJSON_GetObjectItemCaseSensitive(root, "status_bar_text");
    cJSON* etag       = cJSON_GetObjectItemCaseSensitive(root, "content_etag");
    cJSON* image_etag = cJSON_GetObjectItemCaseSensitive(root, "image_etag");
    cJSON* audio_etag = cJSON_GetObjectItemCaseSensitive(root, "audio_etag");
    cJSON* profile_id = cJSON_GetObjectItemCaseSensitive(root, "profile_id");
    cJSON* width      = cJSON_GetObjectItemCaseSensitive(root, "width");
    cJSON* height     = cJSON_GetObjectItemCaseSensitive(root, "height");
    cJSON* format     = cJSON_GetObjectItemCaseSensitive(root, "pixel_format");
    cJSON* codec      = cJSON_GetObjectItemCaseSensitive(root, "frame_codec");
    cJSON* byte_len   = cJSON_GetObjectItemCaseSensitive(root, "byte_length");
    cJSON* ttl        = cJSON_GetObjectItemCaseSensitive(root, "ttl_sec");
    if (cJSON_IsString(cap) && cap->valuestring)
        out.status_bar_text = cap->valuestring;
    if (cJSON_IsString(etag) && etag->valuestring)
        out.content_etag = etag->valuestring;
    if (cJSON_IsString(image_etag) && image_etag->valuestring)
        out.image_etag = image_etag->valuestring;
    if (cJSON_IsString(audio_etag) && audio_etag->valuestring)
        out.audio_etag = audio_etag->valuestring;
    if (cJSON_IsString(profile_id) && profile_id->valuestring)
        out.profile_id = profile_id->valuestring;
    if (!sync_contract::ReadIntField({cJSON_IsNumber(width), cJSON_IsNumber(width) ? width->valuedouble : 0.0}, 1,
                                     INT32_MAX, out.width) ||
        !sync_contract::ReadIntField({cJSON_IsNumber(height), cJSON_IsNumber(height) ? height->valuedouble : 0.0},
                                     1, INT32_MAX, out.height)) {
        cJSON_Delete(root);
        out = {};
        return false;
    }
    if (cJSON_IsString(format) && format->valuestring)
        out.pixel_format = format->valuestring;
    if (cJSON_IsString(codec) && codec->valuestring)
        out.frame_codec = codec->valuestring;
    display::PixelFormat parsed_format{};
    display::FrameCodec  parsed_codec{};
    if (out.profile_id.empty() || !sync_contract::ParsePixelFormat(out.pixel_format, parsed_format) ||
        !sync_contract::ParseFrameCodec(out.frame_codec, parsed_codec)) {
        cJSON_Delete(root);
        out = {};
        return false;
    }
    std::size_t parsed_byte_len = 0;
    if (!sync_contract::ReadSizeField({cJSON_IsNumber(byte_len), cJSON_IsNumber(byte_len) ? byte_len->valuedouble : 0.0},
                                      display::kMaxFrameBytes, parsed_byte_len)) {
        cJSON_Delete(root);
        out = {};
        return false;
    }
    out.byte_length = parsed_byte_len;
    if (ttl && !cJSON_IsNull(ttl) && !cJSON_IsNumber(ttl)) {
        cJSON_Delete(root);
        out = {};
        return false;
    }
    if (cJSON_IsNumber(ttl)) {
        uint32_t ttl_value = 0;
        if (!sync_contract::ReadUint32Field({true, ttl->valuedouble}, ttl_value)) {
            cJSON_Delete(root);
            out = {};
            return false;
        }
        out.has_ttl = true;
        out.ttl_sec = ttl_value;
    }
    cJSON_Delete(root);
    return true;
}

void ApplyIdentity(cache::FrameMeta& meta, const std::string& profile_id, const display::FrameDescriptor& descriptor) {
    meta.profile_id   = profile_id;
    meta.width        = descriptor.width;
    meta.height       = descriptor.height;
    meta.pixel_format = sync_contract::PixelFormatWire(descriptor.pixel_format);
    meta.frame_codec  = sync_contract::FrameCodecWire(descriptor.codec);
    meta.byte_length  = descriptor.byte_size;
}

bool FrameMetaIdentityMatches(const cache::FrameMeta& meta, const display::DisplayInfo& display_info) {
    return meta.profile_id == (display_info.profile_id ? display_info.profile_id : "") &&
           meta.width == display_info.frame.width && meta.height == display_info.frame.height &&
           meta.pixel_format == sync_contract::PixelFormatWire(display_info.frame.pixel_format) &&
           meta.frame_codec == sync_contract::FrameCodecWire(display_info.frame.codec) &&
           meta.byte_length == display_info.frame.byte_size && display::ValidateFrameDescriptor(display_info.frame);
}

bool UpdateStagedFrameEtag(const std::string& gid, int idx, const std::string& image_etag,
                           const std::string& audio_etag, const std::string& profile_id = "",
                           const display::FrameDescriptor* descriptor = nullptr) {
    cache::FrameMeta meta;
    ReadFrameMetaFile(cache::internal::StageMetaPath(gid, idx), meta);
    if (!image_etag.empty())
        meta.image_etag = image_etag;
    if (!audio_etag.empty())
        meta.audio_etag = audio_etag;
    if (descriptor)
        ApplyIdentity(meta, profile_id, *descriptor);
    return WriteFrameMetaFile(cache::internal::StageMetaPath(gid, idx), meta);
}

}  // namespace

namespace cache {

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag,
                      const display::DisplayInfo& display_info) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::ImagePath(gid, idx).c_str(), &st) != 0)
        return false;
    if (!StatSizeEqualsDescriptor(st, display_info.frame))
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.image_etag == expected_etag &&
           FrameMetaIdentityMatches(meta, display_info);
}

bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                     const display::FrameDescriptor& descriptor) {
    (void)etag;
    if (!display::ValidateFrameDescriptor(descriptor) || bytes.size() != descriptor.byte_size) {
        ESP_LOGW(internal::kTag, "frame image refused idx=%d bytes=%u expected=%u", idx,
                 static_cast<unsigned>(bytes.size()), static_cast<unsigned>(descriptor.byte_size));
        return false;
    }
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    if (!internal::WriteAll(internal::ImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "img"));
    return true;
}

bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out,
                    const display::DisplayInfo& display_info) {
    FrameMeta meta;
    if (!ReadFrameMeta(gid, idx, meta) || !FrameMetaIdentityMatches(meta, display_info))
        return false;
    return internal::ReadAll(internal::ImagePath(gid, idx), out, display_info.frame.byte_size);
}

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag,
                      const display::DisplayInfo& display_info) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::AudioPath(gid, idx).c_str(), &st) != 0)
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.audio_etag == expected_etag &&
           FrameMetaIdentityMatches(meta, display_info);
}

bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    (void)etag;
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    if (!internal::WriteAll(internal::AudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "pcm"));
    return true;
}

bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return internal::ReadAll(internal::AudioPath(gid, idx), out, internal::kMaxAudioReadBytes);
}

void DeleteFrameAudio(const std::string& gid, int idx) {
    unlink(internal::AudioPath(gid, idx).c_str());
    unlink(internal::EtagPath(gid, idx, "pcm").c_str());
}

void DeleteFrameFiles(const std::string& gid, int idx) {
    unlink(internal::ImagePath(gid, idx).c_str());
    unlink(internal::EtagPath(gid, idx, "img").c_str());
    DeleteFrameAudio(gid, idx);
    unlink(internal::MetaPath(gid, idx).c_str());
}

bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    return WriteFrameMetaFile(internal::MetaPath(gid, idx), meta);
}

bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out) {
    return ReadFrameMetaFile(internal::MetaPath(gid, idx), out);
}

bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out, const display::DisplayInfo& display_info) {
    return ReadFrameMetaFile(internal::MetaPath(gid, idx), out) && FrameMetaIdentityMatches(out, display_info);
}

namespace {
bool BeginFrameStage(const std::string& gid) {
    if (gid.empty())
        return false;
    if (!internal::RemoveTree(internal::StageDir(gid)))
        return false;
    internal::DirEnsure(std::string(internal::RootPath()) + "/groups");
    internal::DirEnsure(internal::GroupDir(gid));
    return internal::DirEnsure(internal::StageDir(gid));
}

bool CleanupFrameStage(const std::string& gid) {
    if (!gid.empty())
        return internal::RemoveTree(internal::StageDir(gid));
    return true;
}

bool StagedFrameImageExists(const std::string& gid, int idx, const std::string& expected_etag,
                            const display::DisplayInfo& display_info) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::StageImagePath(gid, idx).c_str(), &st) == 0 &&
        StatSizeEqualsDescriptor(st, display_info.frame)) {
        FrameMeta meta;
        if (ReadFrameMetaFile(internal::StageMetaPath(gid, idx), meta) && meta.image_etag == expected_etag &&
            FrameMetaIdentityMatches(meta, display_info))
            return true;
    }
    return FrameImageExists(gid, idx, expected_etag, display_info);
}

bool WriteStagedFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag, const std::string& profile_id,
                           const display::FrameDescriptor& descriptor) {
    if (!display::ValidateFrameDescriptor(descriptor) || bytes.size() != descriptor.byte_size) {
        ESP_LOGW(internal::kTag, "staged frame image refused idx=%d bytes=%u expected=%u", idx,
                 static_cast<unsigned>(bytes.size()), static_cast<unsigned>(descriptor.byte_size));
        return false;
    }
    internal::DirEnsure(internal::StageDir(gid));
    if (!internal::WriteAll(internal::StageImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::StageDir(gid) + "/" + std::to_string(idx) + ".img.etag");
    return UpdateStagedFrameEtag(gid, idx, etag, "", profile_id, &descriptor);
}

bool StagedFrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag,
                            const display::DisplayInfo& display_info) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::StageAudioPath(gid, idx).c_str(), &st) == 0) {
        FrameMeta meta;
        if (ReadFrameMetaFile(internal::StageMetaPath(gid, idx), meta) && meta.audio_etag == expected_etag &&
            FrameMetaIdentityMatches(meta, display_info))
            return true;
    }
    return FrameAudioExists(gid, idx, expected_etag, display_info);
}

bool WriteStagedFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag, const std::string& profile_id,
                           const display::FrameDescriptor& descriptor) {
    internal::DirEnsure(internal::StageDir(gid));
    if (!internal::WriteAll(internal::StageAudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::StageDir(gid) + "/" + std::to_string(idx) + ".pcm.etag");
    return UpdateStagedFrameEtag(gid, idx, "", etag, profile_id, &descriptor);
}

bool DeleteStagedFrameAudio(const std::string& gid, int idx) {
    internal::DirEnsure(internal::StageDir(gid));
    internal::RemoveIfExists(internal::StageAudioPath(gid, idx));
    FrameMeta meta;
    ReadFrameMetaFile(internal::StageMetaPath(gid, idx), meta);
    meta.audio_etag.clear();
    return WriteFrameMetaFile(internal::StageMetaPath(gid, idx), meta);
}

bool WriteStagedFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    internal::DirEnsure(internal::StageDir(gid));
    return WriteFrameMetaFile(internal::StageMetaPath(gid, idx), meta);
}

bool CommitStagedFrame(const std::string& gid, int idx, const std::string& image_etag, const std::string& audio_etag,
                       const display::DisplayInfo& display_info, std::vector<staging::Swap>& swaps) {
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));

    const std::string staged_image = internal::StageImagePath(gid, idx);
    const std::string staged_meta  = internal::StageMetaPath(gid, idx);
    const std::string staged_audio = internal::StageAudioPath(gid, idx);
    FrameMeta         staged_frame_meta;
    if (!ReadFrameMetaFile(staged_meta, staged_frame_meta)) {
        ESP_LOGW(internal::kTag, "staged meta missing idx=%d", idx);
        return false;
    }
    if (staged_frame_meta.image_etag != image_etag) {
        ESP_LOGW(internal::kTag, "staged image etag mismatch idx=%d", idx);
        return false;
    }
    if (!FrameMetaIdentityMatches(staged_frame_meta, display_info)) {
        ESP_LOGW(internal::kTag, "staged frame identity mismatch idx=%d", idx);
        return false;
    }
    if (!internal::PathExists(staged_image) && !FrameImageExists(gid, idx, image_etag, display_info)) {
        ESP_LOGW(internal::kTag, "frame image missing idx=%d", idx);
        return false;
    }
    if (!audio_etag.empty()) {
        if (staged_frame_meta.audio_etag != audio_etag) {
            ESP_LOGW(internal::kTag, "staged audio etag mismatch idx=%d", idx);
            return false;
        }
        if (!internal::PathExists(staged_audio) && !FrameAudioExists(gid, idx, audio_etag, display_info)) {
            ESP_LOGW(internal::kTag, "frame audio missing idx=%d", idx);
            return false;
        }
    } else if (!staged_frame_meta.audio_etag.empty()) {
        ESP_LOGW(internal::kTag, "staged audio etag mismatch idx=%d", idx);
        return false;
    }

    const std::size_t first_new_swap = swaps.size();
    if (internal::PathExists(staged_image)) {
        swaps.push_back({staged_image, internal::ImagePath(gid, idx), internal::ImagePath(gid, idx) + ".bak"});
    }
    if (!audio_etag.empty() && internal::PathExists(staged_audio)) {
        swaps.push_back({staged_audio, internal::AudioPath(gid, idx), internal::AudioPath(gid, idx) + ".bak"});
    } else if (audio_etag.empty() && internal::PathExists(internal::AudioPath(gid, idx))) {
        swaps.push_back(
            {"", internal::AudioPath(gid, idx), internal::AudioPath(gid, idx) + ".bak", false, false, true});
    }
    swaps.push_back({staged_meta, internal::MetaPath(gid, idx), internal::MetaPath(gid, idx) + ".bak"});

    for (std::size_t i = first_new_swap; i < swaps.size(); ++i) {
        swaps[i].target_existed = internal::PathExists(swaps[i].target);
    }
    if (!staging::WriteJournal(internal::StageJournalPath(gid), swaps)) {
        swaps.resize(first_new_swap);
        return false;
    }
    if (!staging::InstallSwaps(swaps)) {
        (void)staging::RollbackSwaps(swaps);
        return false;
    }
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "img"));
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "pcm"));
    return true;
}
}  // namespace

CacheWriter::CacheWriter(std::string gid) : gid_(std::move(gid)) {
}

CacheWriter::~CacheWriter() {
    Rollback();
}

bool CacheWriter::Begin() {
    if (begun_)
        return true;
    begun_ = BeginFrameStage(gid_);
    return begun_;
}

bool CacheWriter::FrameImageExists(int idx, const std::string& expected_etag,
                                   const display::DisplayInfo& display_info) const {
    return begun_ && StagedFrameImageExists(gid_, idx, expected_etag, display_info);
}

bool CacheWriter::WriteFrameImage(int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                                  const std::string& profile_id, const display::FrameDescriptor& descriptor) {
    return begun_ && WriteStagedFrameImage(gid_, idx, bytes, etag, profile_id, descriptor);
}

bool CacheWriter::FrameAudioExists(int idx, const std::string& expected_etag,
                                   const display::DisplayInfo& display_info) const {
    return begun_ && StagedFrameAudioExists(gid_, idx, expected_etag, display_info);
}

bool CacheWriter::WriteFrameAudio(int idx, const std::vector<uint8_t>& bytes, const std::string& etag,
                                  const std::string& profile_id, const display::FrameDescriptor& descriptor) {
    return begun_ && WriteStagedFrameAudio(gid_, idx, bytes, etag, profile_id, descriptor);
}

bool CacheWriter::DeleteFrameAudio(int idx) {
    return begun_ && DeleteStagedFrameAudio(gid_, idx);
}

bool CacheWriter::WriteFrameMeta(int idx, const FrameMeta& meta) {
    return begun_ && WriteStagedFrameMeta(gid_, idx, meta);
}

bool CacheWriter::CommitFrame(int idx, const std::string& image_etag, const std::string& audio_etag,
                              const display::DisplayInfo& display_info) {
    return begun_ && CommitStagedFrame(gid_, idx, image_etag, audio_etag, display_info, swaps_);
}

bool CacheWriter::CommitManifest(const std::string& manifest_etag, int content_count, const std::string& name,
                                 const display::DisplayInfo& display_info) {
    if (!begun_)
        return false;
    ManifestMeta old;
    ReadManifestMeta(gid_, old);
    const std::string staged_manifest = internal::StageDir(gid_) + "/manifest.json";
    if (!internal::WriteManifestFile(staged_manifest, gid_, manifest_etag, content_count,
                                     name.empty() ? old.name : name, old.last_access_seq, display_info)) {
        return false;
    }
    const std::size_t first_new_swap = swaps_.size();
    swaps_.push_back({staged_manifest, internal::ManifestPath(gid_), internal::ManifestPath(gid_) + ".bak"});
    swaps_.back().target_existed = internal::PathExists(swaps_.back().target);
    if (!staging::WriteJournal(internal::StageJournalPath(gid_), swaps_)) {
        swaps_.resize(first_new_swap);
        return false;
    }
    if (!staging::InstallSwaps(swaps_)) {
        (void)staging::RollbackSwaps(swaps_);
        return false;
    }
    return true;
}

bool CacheWriter::CommitStateMeta(const std::string& selected_group_id, const std::string& etag) {
    if (!begun_)
        return false;
    const std::string staged_state = internal::StageDir(gid_) + "/state.json";
    if (!internal::WriteStagedStateMetaFile(staged_state, selected_group_id, etag))
        return false;
    const std::size_t first_new_swap = swaps_.size();
    swaps_.push_back({staged_state, internal::StatePath(), internal::StatePath() + ".bak"});
    swaps_.back().target_existed = internal::PathExists(swaps_.back().target);
    if (!staging::WriteJournal(internal::StageJournalPath(gid_), swaps_)) {
        swaps_.resize(first_new_swap);
        return false;
    }
    if (!staging::InstallSwaps(swaps_)) {
        (void)staging::RollbackSwaps(swaps_);
        return false;
    }
    return true;
}

bool CacheWriter::Commit() {
    if (!begun_)
        return false;
    if (!staging::RemoveJournal(internal::StageJournalPath(gid_)))
        return false;
    (void)staging::FinalizeSwaps(swaps_);
    internal::ResetStateCache();
    committed_ = true;
    CleanupFrameStage(gid_);
    return true;
}

bool CacheWriter::Rollback() {
    if (begun_ && !committed_) {
        if (!staging::RollbackSwaps(swaps_))
            return false;
        if (!staging::RemoveJournal(internal::StageJournalPath(gid_)))
            return false;
        if (!CleanupFrameStage(gid_))
            return false;
    }
    swaps_.clear();
    begun_     = false;
    committed_ = false;
    internal::ResetStateCache();
    return true;
}

}  // namespace cache
