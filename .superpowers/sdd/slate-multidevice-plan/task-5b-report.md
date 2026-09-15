# Task 5B Report — Firmware API v2 / descriptor validation / cache identity

## Scope

- Firmware code, host firmware tests, and the explicitly allowed `firmware/README.md` v1/register-field residue were changed.
- `.omo/` was not touched.

## RED

- Added host contract tests referencing missing `sync/manifest_contract.h`; strict host compile failed with:
  - `fatal error: 'sync/manifest_contract.h' file not found`
- Added downloadable-content contract test before implementation; strict host link failed with:
  - `Undefined symbols ... sync_contract::ContentIsDownloadable(...)`
- After review, added/extended RED cases for strict numeric parsing, duplicate/missing seq rejection, nullable audio/next-wake handling, stale cache identity, and group swap rollback before tightening production helpers.
- Added POSIX host staging tests around installed-swap rollback/finalize semantics before refactoring grouped frame+manifest swaps.
- Second review RED additions:
  - `ReadSizeField` SIZE_MAX/2^64 probe under float-cast sanitizer and 32-bit syntax check.
  - Manifest response envelope must reject empty/mismatched `group_id` before any download/cache mutation.
  - Typed nullable fields: non-string `audio_etag` rejected; `audio_size` null/missing allowed only without audio etag; group/current_content reject non-object non-null.
  - Real cache production wiring host test for identity-less metadata invalidation, audio-only CacheWriter identity+commit, state-failure rollback, and successful finalize backup cleanup.
  - Staging primitive test switched from hard-coded `/private/tmp` to TMPDIR/`/tmp` with RAII cleanup and mkdtemp failure checks.

## GREEN

- Added pure host-testable `sync/manifest_contract` helpers for:
  - API prefix and v2 registration JSON body
  - real app-version selection fallback
  - frame/profile wire string conversion
  - finite, integral, bounded numeric reads for `int`, `size_t`, and `uint32_t`
  - `size_t` numeric reads bounded to exact JSON integer range on 64-bit without unsafe float-to-size_t comparison/cast; 32-bit keeps native bound
  - manifest/content descriptor validation against current `DisplayInfo`
  - manifest envelope validation requiring response `group_id` to be non-empty and equal the requested group
  - duplicate/negative content sequence rejection
  - typed nullable string/number/object field validation used by the API parser
  - exact image payload length validation
  - cache identity matching and old-metadata cache-hit rejection
  - audio capability filtering
- Updated firmware API client to:
  - use `/api/v2`
  - register with `mac`, `board_id`, `protocol_version:2`, and real app version from `esp_app_get_description()`
  - parse and strictly validate v2 `display_profile` and per-content `frame`
  - reject missing/non-ready `variant_status`, duplicate/missing `seq`, mismatched `image_size`, missing `contents`, malformed/overflowing/fractional numbers, unsupported format/codec, and cross-profile descriptors
  - reject empty/mismatched manifest response `group_id` before sync/cache mutation
  - accept nullable/missing `audio_size` only when `audio_etag` is empty, require exact integer size when audio etag exists, and reject non-string `audio_etag`
  - accept nullable `next_wake_sec` while rejecting non-integral numeric values
  - require group `position` when group metadata is present; reject group/current_content if present but not object/null
- Updated sync/cache paths to:
  - validate exact image byte length before writing staged cache
  - persist profile/descriptor identity into manifest and frame metadata
  - treat old identity-less metadata as cache miss
  - avoid sending `If-None-Match` from identity-mismatched manifest cache
  - make frame reads and cache hits display-aware instead of fixed 15000 bytes
  - skip audio requests/resources when display capabilities disable audio
  - write descriptor identity when staging audio-only updates, so image-hit/audio-miss paths validate and commit
  - install frame/audio/meta/manifest swaps as one writer transaction and roll back all installed files on pre-state failures
  - finalize swap backups before prune/delete/touch cleanup after state write succeeds; backup cleanup is best-effort after the logical commit point
  - restore in-memory state cache when state persistence fails
  - strictly reject malformed frame/manifest cache metadata instead of truncating/defaulting numeric identity fields
  - block cached audio playback on no-audio display capability before `ReadFrameAudio`/AudioPlayer paths
  - compare `st_size` to descriptor byte length via non-negative uint64 comparison instead of casting descriptor size to `off_t`
- Added a host cache integration target that compiles the same production cache sources (`cache_frames`, `cache_manifest`, `cache_state`, `cache_paths`, `cache_io`, `cache_staging`) with host shims for ESP/cJSON dependencies. It executes the same metadata and CacheWriter branches rather than a parallel implementation.
- API parser host coverage is through the same production validation seam called by `api_client.cc` (`ValidateManifestEnvelope`, typed nullable helpers, optional-object helper); cache metadata/transaction coverage executes production cache source directly.
- Added `board_id` into Xiaozhi OTA/board metadata.
- Removed fixed frame-image read cap and stale cache/frame-view coupling from cache IO comments/includes.
- Updated the two stale firmware README `/api/v1` references, registration field description, FrameMeta identity fields, and transaction/no-journal limitation.

## Verification

- strict host C++17:
  - `clang++ -std=c++17 -Wall -Wextra -Werror -fno-exceptions -fno-rtti ... display_contract_test.cc ... && /private/tmp/slate_display_contract_strict` passed
  - `clang++ -std=c++17 -Wall -Wextra -Werror -fno-exceptions -fno-rtti ... cache_staging_test.cc ... && /private/tmp/slate_cache_staging_test` passed
  - `clang++ -std=c++17 -Wall -Wextra -Werror -fno-exceptions -fno-rtti -DSLATE_HOST_TEST ... cache_integration_test.cc ... cache_{frames,manifest,state,paths,io,staging}.cc ... && /private/tmp/slate_cache_integration_test` passed
- NDEBUG host C++17:
  - `clang++ ... -DNDEBUG ... display_contract_test.cc ... && /private/tmp/slate_display_contract_ndebug` passed
  - `clang++ ... -DNDEBUG ... cache_staging_test.cc ... && /private/tmp/slate_cache_staging_ndebug` passed
  - `clang++ ... -DNDEBUG -DSLATE_HOST_TEST ... cache_integration_test.cc ... && /private/tmp/slate_cache_integration_ndebug` passed
- ASan/UBSan host C++17:
  - `clang++ ... -fsanitize=address,undefined,float-cast-overflow ... display_contract_test.cc ... && /private/tmp/slate_display_contract_san` passed
  - `clang++ ... -fsanitize=address,undefined,float-cast-overflow ... cache_staging_test.cc ... && /private/tmp/slate_cache_staging_san` passed
  - `clang++ ... -fsanitize=address,undefined,float-cast-overflow -DSLATE_HOST_TEST ... cache_integration_test.cc ... && /private/tmp/slate_cache_integration_san` passed
- 32-bit syntax check:
  - `clang++ -m32 -std=c++17 -Wall -Wextra -Werror -fsyntax-only ... manifest_contract.cc display_contract.cc` passed
- unknown board compile rejection:
  - `SLATE_BOARD_ID="unknown-board"` failed at `board_platform.cc` static_assert as expected
- stale endpoint scan:
  - `rg -n "/api/v1|protocol v3|kApiPrefix|kFrameImageBytes|cache_io.h.*frame_view|/private/tmp" firmware` returned no matches
- scope check:
  - `git diff --name-only | rg -v '^(firmware/|\.superpowers/)'` returned no matches
- whitespace:
  - `git diff --check -- firmware .superpowers/sdd/slate-multidevice-plan/task-5b-report.md` passed
- repo format:
  - `bun run format:check` still fails only on ignored runtime `.omo/.omx/state` JSON files

## Remaining risk

- The new grouped cache transaction is operation-failure atomic while power remains on: installed swaps keep backups until state write succeeds and are rolled back on pre-state errors. There is still no durable journal/recovery scan, so a power loss between individual renames can leave `.bak`/staged artifacts that require a future journal/recovery task to repair deterministically.

## Environment gaps

- `cmake` is not installed, so host CMake/CTest target could not be run.
- `idf.py` is not on PATH and `IDF_PATH` is empty, so ESP-IDF 5.5.x firmware build could not be run locally.
