import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameDescriptorForProfile,
  type FrameDescriptorT,
} from 'shared';

export function effectiveImagePreviewDescriptor(
  imageFile: File | null,
  selectedDescriptor: FrameDescriptorT
): FrameDescriptorT {
  return imageFile ? frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID) : selectedDescriptor;
}
