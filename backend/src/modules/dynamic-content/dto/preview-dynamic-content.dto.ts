import { PreviewDynamicContentRequest, type PreviewDynamicContentRequestT } from 'shared';

export class PreviewDynamicContentDto implements PreviewDynamicContentRequestT {
  static readonly schema = PreviewDynamicContentRequest;
  declare config: PreviewDynamicContentRequestT['config'];
  declare display_profile_id: PreviewDynamicContentRequestT['display_profile_id'];
  declare frame_name?: string | null;
  declare data?: PreviewDynamicContentRequestT['data'];
}
