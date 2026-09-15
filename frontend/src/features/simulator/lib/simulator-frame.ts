import {
  displayProfilesForEnvironment,
  type ContentSummaryT,
  type DisplayProfileEnvironmentT,
  type FrameDescriptorT,
  type ManifestResponseT,
} from 'shared';

export interface BatchSnapshotEntry {
  contentId: string;
  filename: string;
  bytes: Uint8Array;
  descriptor: FrameDescriptorT;
}

export function manifestQueryKey(groupId: string | undefined, profileId: string) {
  return ['simulator', 'manifest', groupId, profileId] as const;
}

export function frameQueryKey(
  contentId: string | undefined,
  imageEtag: string | undefined | null,
  profileId: string
) {
  return ['simulator', 'frame', contentId, profileId, imageEtag ?? null] as const;
}

export function simulatorProfileIds(environment: DisplayProfileEnvironmentT): string[] {
  return displayProfilesForEnvironment(environment).map((profile) => profile.id);
}

export function resolveSelectedContentId(
  contents: readonly ContentSummaryT[],
  selectedContentId: string | null
): string | null {
  if (
    selectedContentId &&
    contents.some(
      (content) => content.id === selectedContentId && content.variant_status === 'ready'
    )
  ) {
    return selectedContentId;
  }
  return contents.find((content) => content.variant_status === 'ready')?.id ?? null;
}

export function selectedFrameFilename(
  manifest: ManifestResponseT,
  content: ContentSummaryT
): string {
  const seq = String(content.seq + 1).padStart(2, '0');
  return sanitizeFilename(
    `slate-${manifest.group.id}-${seq}-${content.id}-${content.frame.profile_id}-${content.image_etag}.png`
  );
}

export function batchSnapshotEntries(
  manifest: ManifestResponseT,
  rawByContentId: ReadonlyMap<string, Uint8Array>
): BatchSnapshotEntry[] {
  return manifest.contents
    .filter((content) => content.variant_status === 'ready')
    .map((content) => {
      const bytes = rawByContentId.get(content.id);
      if (!bytes) return null;
      return {
        contentId: content.id,
        filename: selectedFrameFilename(manifest, content),
        bytes,
        descriptor: content.frame,
      };
    })
    .filter((entry): entry is BatchSnapshotEntry => entry !== null);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
