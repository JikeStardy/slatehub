import { createRef } from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameDescriptorForProfile } from 'shared';
import { PreviewCanvas } from './PreviewCanvas';
import { effectiveImagePreviewDescriptor } from './image-preview-descriptor';

describe('PreviewCanvas profile wiring', () => {
  it('renders virtual saved-frame previews with the selected descriptor dimensions', () => {
    const descriptor = frameDescriptorForProfile('virtual-mono-296x128');
    const markup = renderToStaticMarkup(
      <PreviewCanvas
        canvasRef={createRef<HTMLCanvasElement>()}
        imageFile={null}
        existingImage={new ArrayBuffer(descriptor.byte_length)}
        descriptor={descriptor}
        threshold={128}
        mode="floyd"
        scale={1}
        offset={{ x: 0, y: 0 }}
        onOffsetChange={() => undefined}
        showStatusBar={false}
      />
    );

    expect(markup).toContain('width="296"');
    expect(markup).toContain('height="128"');
    expect(markup).toContain('aspect-ratio:296 / 128');
  });

  it('uses the same Note4 descriptor for upload authoring even when virtual is selected', () => {
    const descriptor = frameDescriptorForProfile('virtual-mono-296x128');
    const file = new File(['x'], 'frame.png', { type: 'image/png' });
    const effective = effectiveImagePreviewDescriptor(file, descriptor);
    const markup = renderToStaticMarkup(
      <PreviewCanvas
        canvasRef={createRef<HTMLCanvasElement>()}
        imageFile={file}
        existingImage={undefined}
        descriptor={descriptor}
        threshold={128}
        mode="floyd"
        scale={1}
        offset={{ x: 0, y: 0 }}
        onOffsetChange={() => undefined}
        showStatusBar={false}
      />
    );

    expect(effective).toEqual(frameDescriptorForProfile('zectrix-note4-400x300-mono'));
    expect(markup).toContain('width="400"');
    expect(markup).toContain('height="300"');
    expect(markup).toContain('aspect-ratio:400 / 300');
  });
});
