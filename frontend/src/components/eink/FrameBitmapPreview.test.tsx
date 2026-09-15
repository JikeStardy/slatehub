import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameDescriptorForProfile } from 'shared';
import { FrameBitmapPreview } from './FrameBitmapPreview';

describe('FrameBitmapPreview descriptor sizing', () => {
  it('sets the intrinsic canvas and outer aspect ratio from FrameDescriptor', () => {
    const descriptor = frameDescriptorForProfile('virtual-mono-296x128');
    const markup = renderToStaticMarkup(
      <FrameBitmapPreview data={null} descriptor={descriptor} showStatusBar={false} />
    );

    expect(markup).toContain('width="296"');
    expect(markup).toContain('height="128"');
    expect(markup).toContain('aspect-ratio:296 / 128');
  });
});
