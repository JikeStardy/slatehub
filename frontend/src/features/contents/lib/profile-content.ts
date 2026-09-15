import { frameDescriptorForProfile, type ContentDetailT } from 'shared';

export function pendingContentForProfile(
  content: ContentDetailT,
  profileId: string
): ContentDetailT {
  return {
    ...content,
    content_etag: '',
    image_etag: '',
    image_size: 0,
    variant_status: 'pending',
    frame: frameDescriptorForProfile(profileId),
  };
}
