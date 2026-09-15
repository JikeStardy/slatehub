import type { CSSProperties } from 'react';
import type { FrameDescriptorT } from 'shared';

export interface SimulatorStageBounds {
  containerWidth: number;
  viewportHeight: number;
}

export interface SimulatorStageCanvasMetrics {
  width: number;
  height: number;
}

export function simulatorStageCanvasStyle(descriptor: FrameDescriptorT): CSSProperties {
  return {
    aspectRatio: `${descriptor.width} / ${descriptor.height}`,
    height: 'auto',
    imageRendering: 'pixelated',
    width: `min(100%, calc(72vh * ${descriptor.width} / ${descriptor.height}))`,
  };
}

export function simulatorStageCanvasMetrics(
  descriptor: FrameDescriptorT,
  bounds: SimulatorStageBounds
): SimulatorStageCanvasMetrics {
  const ratio = descriptor.width / descriptor.height;
  const maxHeight = bounds.viewportHeight * 0.72;
  const width = Math.min(bounds.containerWidth, maxHeight * ratio);
  return {
    width: round2(width),
    height: round2(width / ratio),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
