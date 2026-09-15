#include "sync/sync_service.h"

#include <esp_log.h>

#include "bsp/board.h"
#include "events/event_bus.h"
#include "power/power_state.h"
#include "sync/manifest_contract.h"
#include "sync/sync_internal.h"
#include "utils/time_utils.h"

using sync_internal::ClampProgressCount;
using sync_internal::ExistingAudioEtag;
using sync_internal::ExistingImageEtag;
using sync_internal::kCacheMinFreeBytes;
using sync_internal::kMaxCachedGroups;
using sync_internal::kTag;

bool SyncService::HandleCachedManifestHit(const std::string& gid, const std::string& expected_etag,
                                          const std::string& status_name, int content_count,
                                          const std::string& previous_current, const std::string& selected_group_id,
                                          SyncReason reason) {
    if (!cache::WriteStateMeta(gid, expected_etag))
        return false;
    cache::TouchGroup(gid);
    SetCurrentGroup(gid);
    if (reason == SyncReason::kCycle && previous_current != gid)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleCacheHit, gid, status_name);
    if (previous_current != gid || selected_group_id != gid)
        PostSyncedGroupReady(gid, status_name, content_count, /*content_changed=*/false);
    return true;
}

bool SyncService::HandleNotModifiedManifest(const std::string& gid, const cache::ManifestMeta& cached_meta,
                                            const std::string& status_name, int expected_content_count,
                                            const std::string& previous_current, const std::string& selected_group_id,
                                            SyncReason reason) {
    const bool first_seen = (previous_current != gid || selected_group_id != gid);
    if (!cache::WriteStateMeta(gid, cached_meta.manifest_etag))
        return false;
    cache::TouchGroup(gid);
    SetCurrentGroup(gid);
    if (reason == SyncReason::kCycle && first_seen)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleCacheHit, gid, status_name);
    if (first_seen) {
        const int content_count = expected_content_count >= 0 ? expected_content_count : cached_meta.content_count;
        PostSyncedGroupReady(gid, status_name, content_count, /*content_changed=*/false);
    }
    return true;
}

bool SyncService::DownloadFramesToStage(cache::CacheWriter& writer, const std::string& gid,
                                        const api::Manifest& manifest, const std::string& status_name,
                                        const std::string& previous_current, const std::string& selected_group_id,
                                        SyncReason reason, int& total_updates) {
    total_updates = 0;
    const display::DisplayInfo& display_info = Board::Get().platform().Display();
    for (const auto& f : manifest.contents) {
        sync_contract::ContentIdentity content{f.seq,          f.id,         f.image_etag, f.audio_etag,
                                               f.variant_status, f.image_size, f.frame_profile_id, f.frame};
        if (!sync_contract::ContentIsDownloadable(content)) {
            ESP_LOGW(kTag, "frame skipped reason=variant_not_ready seq=%d", f.seq);
            continue;
        }
        if (!writer.FrameImageExists(f.seq, f.image_etag, display_info))
            ++total_updates;
        if (!f.audio_etag.empty() && !writer.FrameAudioExists(f.seq, f.audio_etag, display_info))
            ++total_updates;
    }

    int        done     = 0;
    bool       complete = true;
    const bool current_group_update =
        reason != SyncReason::kCycle && (previous_current == gid || selected_group_id == gid);
    const GroupSyncStatusMode progress_mode = reason == SyncReason::kCycle ? GroupSyncStatusMode::kCycleDownloading
                                              : current_group_update       ? GroupSyncStatusMode::kCurrentGroupUpdating
                                                                     : GroupSyncStatusMode::kInitialGroupDownloading;
    const std::string         progress_name = !manifest.group_name.empty() ? manifest.group_name : status_name;
    auto                      post_progress = [&]() {
        const uint8_t cur = ClampProgressCount(done);
        const uint8_t all = ClampProgressCount(total_updates);
        evt::PostGroupSyncStatus(progress_mode, gid, progress_name, cur, all);
        evt::PostSyncProgress(cur, all);
    };
    if (total_updates > 0)
        post_progress();

    bool warned_missing_id = false;
    for (const auto& f : manifest.contents) {
        if (ShouldStop())
            return false;
        sync_contract::ContentIdentity content{f.seq,          f.id,         f.image_etag, f.audio_etag,
                                               f.variant_status, f.image_size, f.frame_profile_id, f.frame};
        if (!sync_contract::ContentIsDownloadable(content)) {
            if (!warned_missing_id) {
                ESP_LOGW(kTag, "frame skipped reason=not_downloadable seq=%d", f.seq);
                warned_missing_id = true;
            }
            complete = false;
            continue;
        }
        if (!writer.FrameImageExists(f.seq, f.image_etag, display_info)) {
            bool          nm               = false;
            const int64_t image_started_ms = time_utils::NowMs();
            const auto    image_if_none    = ExistingImageEtag(gid, f.seq, f.image_etag, display_info);
            download_buf_.clear();
            if (api::DownloadContentImage(f.id, image_if_none, download_buf_, nm)) {
                if (nm) {
                    ESP_LOGW(kTag, "frame image unexpected not_modified seq=%d", f.seq);
                    complete = false;
                } else if (!sync_contract::ImagePayloadMatchesDescriptor(download_buf_, f.frame)) {
                    ESP_LOGW(kTag, "frame image refused seq=%d bytes=%u expected=%u", f.seq,
                             static_cast<unsigned>(download_buf_.size()), static_cast<unsigned>(f.frame.byte_size));
                    complete = false;
                } else if (!writer.WriteFrameImage(f.seq, download_buf_, f.image_etag, f.frame_profile_id, f.frame)) {
                    ESP_LOGW(kTag, "frame image write failed seq=%d", f.seq);
                    complete = false;
                }
            } else {
                ESP_LOGW(kTag, "frame image download failed seq=%d elapsed_ms=%lld", f.seq,
                         (long long)(time_utils::NowMs() - image_started_ms));
                complete = false;
            }
            ++done;
            post_progress();
        }
        if (ShouldStop())
            return false;
        if (!f.audio_etag.empty() && !writer.FrameAudioExists(f.seq, f.audio_etag, display_info)) {
            bool          nm               = false;
            const int64_t audio_started_ms = time_utils::NowMs();
            const auto    audio_if_none    = ExistingAudioEtag(gid, f.seq, f.audio_etag, display_info);
            download_buf_.clear();
            if (api::DownloadContentAudio(f.id, audio_if_none, download_buf_, nm)) {
                if (nm) {
                    ESP_LOGW(kTag, "frame audio unexpected not_modified seq=%d", f.seq);
                    complete = false;
                } else if (!writer.WriteFrameAudio(f.seq, download_buf_, f.audio_etag)) {
                    ESP_LOGW(kTag, "frame audio write failed seq=%d", f.seq);
                    complete = false;
                }
            } else {
                ESP_LOGW(kTag, "frame audio download failed seq=%d elapsed_ms=%lld", f.seq,
                         (long long)(time_utils::NowMs() - audio_started_ms));
                complete = false;
            }
            ++done;
            post_progress();
        }

        if (writer.FrameImageExists(f.seq, f.image_etag, display_info) &&
            (f.audio_etag.empty() || writer.FrameAudioExists(f.seq, f.audio_etag, display_info))) {
            cache::FrameMeta fm;
            fm.status_bar_text = f.device_status_bar_text;
            fm.content_etag    = f.content_etag;
            fm.image_etag      = f.image_etag;
            fm.audio_etag      = f.audio_etag;
            fm.profile_id      = f.frame_profile_id;
            fm.width           = f.frame.width;
            fm.height          = f.frame.height;
            fm.pixel_format    = sync_contract::PixelFormatWire(f.frame.pixel_format);
            fm.frame_codec     = sync_contract::FrameCodecWire(f.frame.codec);
            fm.byte_length     = f.frame.byte_size;
            // next_wake_sec<=0 视为非动态帧(不配 RTC timer)：0 曾被当成动态并被 60s
            // 地板顶起来反复空醒。真正需要定时刷新的帧后端会给 >0 的秒数。
            fm.has_ttl = f.has_next_wake_sec && f.next_wake_sec > 0;
            fm.ttl_sec = fm.has_ttl ? static_cast<uint32_t>(f.next_wake_sec) : 0;
            if (!writer.WriteFrameMeta(f.seq, fm)) {
                ESP_LOGW(kTag, "frame meta write failed seq=%d", f.seq);
                complete = false;
            }
        } else {
            complete = false;
        }
    }
    return complete;
}

bool SyncService::CommitStagedFrames(cache::CacheWriter& writer, const std::string& gid, const api::Manifest& manifest,
                                     const std::string& group_name, const std::string& selected_group_id,
                                     bool current_group_update, SyncReason reason, int total_updates,
                                     int old_content_count) {
    const std::string         synced_name = !manifest.group_name.empty() ? manifest.group_name : group_name;
    const GroupSyncStatusMode saving_mode =
        current_group_update ? GroupSyncStatusMode::kCurrentGroupSaving : GroupSyncStatusMode::kTargetGroupSaving;
    const int total = static_cast<int>(manifest.contents.size());
    int       saved = 0;
    if (total > 0)
        evt::PostGroupSyncStatus(saving_mode, gid, synced_name, 0, ClampProgressCount(total));
    for (const auto& f : manifest.contents) {
        if (!writer.CommitFrame(f.seq, f.image_etag, f.audio_etag, Board::Get().platform().Display())) {
            ESP_LOGW(kTag, "frame commit failed seq=%d", f.seq);
            writer.Rollback();
            return false;
        }
        ++saved;
        evt::PostGroupSyncStatus(saving_mode, gid, synced_name, ClampProgressCount(saved), ClampProgressCount(total));
    }
    if (!cache::WriteManifest(gid, manifest.manifest_etag, manifest.contents.size(), synced_name,
                              Board::Get().platform().Display())) {
        ESP_LOGW(kTag, "manifest write failed action=rollback");
        writer.Rollback();
        return false;
    }
    if (!cache::WriteStateMeta(gid, manifest.manifest_etag)) {
        ESP_LOGW(kTag, "state write failed action=rollback");
        writer.Rollback();
        return false;
    }
    cache::TouchGroup(gid);
    cache::PruneOldGroups(selected_group_id, gid, kCacheMinFreeBytes, kMaxCachedGroups);
    for (const auto& f : manifest.contents) {
        if (f.audio_etag.empty())
            cache::DeleteFrameAudio(gid, f.seq);
    }
    for (int idx = total; idx < old_content_count; ++idx) {
        cache::DeleteFrameFiles(gid, idx);
    }
    writer.Commit();
    SetCurrentGroup(gid);
    if (reason == SyncReason::kCycle && total_updates == 0)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleCacheHit, gid, synced_name);
    PostSyncedGroupReady(gid, synced_name, static_cast<int>(manifest.contents.size()), /*content_changed=*/true);
    return true;
}

bool SyncService::SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag,
                                        const std::string& group_name, int expected_content_count, SyncReason reason,
                                        bool& group_changed) {
    group_changed = false;
    if (gid.empty())
        return true;
    if (expected_etag.empty()) {
        ESP_LOGE(kTag, "sync manifest failed reason=expected_etag_empty");
        return false;
    }

    const std::string previous_current = CurrentGroupSnapshot();
    std::string       selected_group_id, selected_etag;
    cache::ReadStateMeta(selected_group_id, selected_etag);

    cache::ManifestMeta cached_meta;
    bool                cached_meta_ok = cache::ReadManifestMeta(gid, cached_meta);
    cached_meta_ok = cached_meta_ok && cache::ManifestIdentityMatches(cached_meta, Board::Get().platform().Display());
    if (cached_meta_ok && !group_name.empty() && cached_meta.name != group_name) {
        cache::WriteManifest(gid, cached_meta.manifest_etag, cached_meta.content_count, group_name,
                             Board::Get().platform().Display());
        cached_meta_ok = cache::ReadManifestMeta(gid, cached_meta);
        cached_meta_ok = cached_meta_ok && cache::ManifestIdentityMatches(cached_meta, Board::Get().platform().Display());
    }
    const std::string status_name = !group_name.empty() ? group_name : cached_meta.name;

    if (cached_meta_ok && cached_meta.manifest_etag == expected_etag) {
        const int content_count = expected_content_count >= 0 ? expected_content_count : cached_meta.content_count;
        return HandleCachedManifestHit(gid, expected_etag, status_name, content_count, previous_current,
                                       selected_group_id, reason);
    }

    api::Manifest mf;
    bool          not_modified = false;
    std::string   if_none_match;
    if (cached_meta_ok && !cached_meta.manifest_etag.empty())
        if_none_match = cached_meta.manifest_etag;
    if (!api::GetManifest(gid, if_none_match, mf, not_modified)) {
        ESP_LOGW(kTag, "manifest fetch failed");
        return false;
    }
    if (not_modified) {
        return HandleNotModifiedManifest(gid, cached_meta, status_name, expected_content_count, previous_current,
                                         selected_group_id, reason);
    }
    if (ShouldStop())
        return false;

    int old_content_count = 0;
    cache::ReadManifestContentCount(gid, old_content_count, Board::Get().platform().Display());
    cache::CacheWriter writer(gid);
    if (!writer.Begin()) {
        ESP_LOGW(kTag, "frame stage init failed");
        return false;
    }

    int total_updates = 0;
    if (!DownloadFramesToStage(writer, gid, mf, status_name, previous_current, selected_group_id, reason,
                               total_updates)) {
        ESP_LOGW(kTag, "manifest sync incomplete action=rollback");
        writer.Rollback();
        return false;
    }
    if (ShouldStop()) {
        writer.Rollback();
        return false;
    }

    const bool current_group_update =
        reason != SyncReason::kCycle && (previous_current == gid || selected_group_id == gid);
    if (!CommitStagedFrames(writer, gid, mf, group_name, selected_group_id, current_group_update, reason, total_updates,
                            old_content_count)) {
        return false;
    }
    group_changed = true;
    return true;
}

bool SyncService::SyncCurrentContent(const std::string& gid, const api::ContentMeta& f, bool& changed) {
    changed = false;
    if (gid.empty() || f.id.empty() || f.seq < 0 || f.image_etag.empty())
        return false;

    cache::FrameMeta old_meta;
    const bool       old_meta_ok = cache::ReadFrameMeta(gid, f.seq, old_meta);
    cache::FrameMeta next_meta;
    next_meta.status_bar_text = f.device_status_bar_text;
    next_meta.content_etag    = f.content_etag;
    next_meta.image_etag      = f.image_etag;
    next_meta.audio_etag      = f.audio_etag;
    next_meta.profile_id      = f.frame_profile_id;
    next_meta.width           = f.frame.width;
    next_meta.height          = f.frame.height;
    next_meta.pixel_format    = sync_contract::PixelFormatWire(f.frame.pixel_format);
    next_meta.frame_codec     = sync_contract::FrameCodecWire(f.frame.codec);
    next_meta.byte_length     = f.frame.byte_size;
    // 同上：next_wake_sec<=0 当非动态帧，避免 0 被 60s 地板顶起来反复空醒。
    next_meta.has_ttl = f.has_next_wake_sec && f.next_wake_sec > 0;
    next_meta.ttl_sec = next_meta.has_ttl ? static_cast<uint32_t>(f.next_wake_sec) : 0;

    if (old_meta_ok && !f.content_etag.empty() && old_meta.content_etag == f.content_etag &&
        cache::FrameImageExists(gid, f.seq, f.image_etag, Board::Get().platform().Display()) &&
        (f.audio_etag.empty() || cache::FrameAudioExists(gid, f.seq, f.audio_etag,
                                                        Board::Get().platform().Display()))) {
        if (old_meta.status_bar_text != next_meta.status_bar_text || old_meta.has_ttl != next_meta.has_ttl ||
            old_meta.ttl_sec != next_meta.ttl_sec || old_meta.image_etag != next_meta.image_etag ||
            old_meta.audio_etag != next_meta.audio_etag) {
            if (!cache::WriteFrameMeta(gid, f.seq, next_meta)) {
                ESP_LOGW(kTag, "frame meta write failed seq=%d", f.seq);
                return false;
            }
        }
        power_state::SetCurrentFrameFromMeta(f.seq, next_meta);
        changed = old_meta.status_bar_text != next_meta.status_bar_text ||
                  (!old_meta.image_etag.empty() && old_meta.image_etag != next_meta.image_etag);
        return true;
    }

    const bool image_etag_changed =
        !old_meta_ok || (!old_meta.image_etag.empty() && old_meta.image_etag != f.image_etag);
    const bool status_bar_changed = !old_meta_ok || old_meta.status_bar_text != next_meta.status_bar_text;
    bool       image_downloaded   = false;
    if (ShouldStop())
        return false;
    sync_contract::ContentIdentity content{f.seq,          f.id,         f.image_etag, f.audio_etag,
                                           f.variant_status, f.image_size, f.frame_profile_id, f.frame};
    if (!sync_contract::ContentIsDownloadable(content))
        return false;
    if (!cache::FrameImageExists(gid, f.seq, f.image_etag, Board::Get().platform().Display())) {
        bool       nm            = false;
        const auto image_if_none = ExistingImageEtag(gid, f.seq, f.image_etag, Board::Get().platform().Display());
        download_buf_.clear();
        if (api::DownloadContentImage(f.id, image_if_none, download_buf_, nm)) {
            if (nm) {
                ESP_LOGW(kTag, "frame image unexpected not_modified seq=%d", f.seq);
                return false;
            }
            if (!sync_contract::ImagePayloadMatchesDescriptor(download_buf_, f.frame)) {
                ESP_LOGW(kTag, "frame image refused seq=%d bytes=%u expected=%u", f.seq,
                         static_cast<unsigned>(download_buf_.size()), static_cast<unsigned>(f.frame.byte_size));
                return false;
            }
            if (!cache::WriteFrameImage(gid, f.seq, download_buf_, f.image_etag, f.frame)) {
                ESP_LOGW(kTag, "frame image write failed seq=%d", f.seq);
                return false;
            }
            image_downloaded = true;
        } else {
            return false;
        }
    }
    if (f.audio_etag.empty()) {
        cache::DeleteFrameAudio(gid, f.seq);
    } else if (!cache::FrameAudioExists(gid, f.seq, f.audio_etag, Board::Get().platform().Display())) {
        if (ShouldStop())
            return false;
        bool       nm            = false;
        const auto audio_if_none = ExistingAudioEtag(gid, f.seq, f.audio_etag, Board::Get().platform().Display());
        download_buf_.clear();
        if (api::DownloadContentAudio(f.id, audio_if_none, download_buf_, nm)) {
            if (nm) {
                ESP_LOGW(kTag, "frame audio unexpected not_modified seq=%d", f.seq);
                return false;
            }
            if (cache::WriteFrameAudio(gid, f.seq, download_buf_, f.audio_etag)) {
                // Audio-only current-content updates should update cache without
                // waking the EPD path; "changed" here means visible pixels changed.
            } else {
                ESP_LOGW(kTag, "frame audio write failed seq=%d", f.seq);
                return false;
            }
        } else {
            ESP_LOGW(kTag, "frame audio download failed seq=%d", f.seq);
            return false;
        }
    }

    if (!cache::WriteFrameMeta(gid, f.seq, next_meta)) {
        ESP_LOGW(kTag, "frame meta write failed seq=%d", f.seq);
        return false;
    }
    power_state::SetCurrentFrameFromMeta(f.seq, next_meta);
    changed = image_downloaded || image_etag_changed || status_bar_changed;
    return true;
}
