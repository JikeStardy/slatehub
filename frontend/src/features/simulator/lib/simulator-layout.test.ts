import { describe, expect, it } from 'bun:test';
import { frameDescriptorForProfile } from 'shared';
import { simulatorStageCanvasMetrics } from './simulator-layout';

const virtualFrame = frameDescriptorForProfile('virtual-mono-296x128');
const note4Frame = frameDescriptorForProfile('zectrix-note4-400x300-mono');

describe('simulator stage canvas responsive sizing', () => {
  it('keeps descriptor ratio when width is constrained by the container', () => {
    expect(
      simulatorStageCanvasMetrics(virtualFrame, { containerWidth: 200, viewportHeight: 1000 })
    ).toEqual({
      width: 200,
      height: 86.49,
    });
    expect(
      simulatorStageCanvasMetrics(note4Frame, { containerWidth: 200, viewportHeight: 1000 })
    ).toEqual({
      width: 200,
      height: 150,
    });
  });

  it('keeps descriptor ratio when height is constrained by 72vh', () => {
    expect(
      simulatorStageCanvasMetrics(virtualFrame, { containerWidth: 2000, viewportHeight: 500 })
    ).toEqual({
      width: 832.5,
      height: 360,
    });
    expect(
      simulatorStageCanvasMetrics(note4Frame, { containerWidth: 2000, viewportHeight: 500 })
    ).toEqual({
      width: 480,
      height: 360,
    });
  });
});
