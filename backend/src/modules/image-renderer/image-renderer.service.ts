import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import {
  API_DEFAULT_DITHER_MODE,
  BW_THRESHOLD_DEFAULT,
  autoContrast,
  autoInvert,
  ditherTo1bpp,
  type DitherMode,
} from 'shared';
import { ValidationError } from '../../common/errors';
import { computeETag } from '../../common/utils/etag';
import {
  assertFrameSize,
  assertSupportedMonoEncoding,
  type RenderTarget,
} from '../rendering/render-target';
import { ImageRenderCacheService } from './image-render-cache.service';

export interface RenderOptions {
  threshold?: number;
  mode?: DitherMode;
  autoInvert?: boolean;
  letterbox?: boolean;
  sourceEtag?: string;
}

export interface RenderResult {
  data: Buffer;
  width: number;
  height: number;
  fromCache: boolean;
}

/**
 * 把任意格式图片(PNG/JPG/WebP/...)转成 EPD 1bpp 帧缓冲。
 *
 * pipeline:
 *   1. sharp:flatten 白底 → letterbox resize → grayscale.raw()
 *   2. shared.autoInvert：四角自适应反相
 *   3. shared.autoContrast：cutoff=1% 拉对比
 *   4. shared.ditherTo1bpp：按 mode 抖动并打包
 *
 * 输出 raw 1bpp packed：每字节 8 像素，MSB first，bit=1 白 / bit=0 黑。
 * 字节序与固件 epd_ssd1683.cc 的 SetPx1 对齐。
 */
@Injectable()
export class ImageRendererService {
  constructor(private readonly cache: ImageRenderCacheService) {}

  async renderTo1bpp(
    input: Buffer,
    target: RenderTarget,
    options: RenderOptions = {}
  ): Promise<RenderResult> {
    assertSupportedMonoEncoding(target);
    const W = target.width;
    const H = target.height;
    const threshold = options.threshold ?? BW_THRESHOLD_DEFAULT;
    const mode = options.mode ?? API_DEFAULT_DITHER_MODE;
    const doAutoInvert = options.autoInvert ?? true;
    const letterbox = options.letterbox ?? true;

    if (W % 8 !== 0) {
      throw new ValidationError(`图宽必须是 8 的倍数，当前为 ${W}`);
    }
    if (W <= 0 || H <= 0) {
      throw new ValidationError(`图片尺寸非法：${W}x${H}`);
    }

    const sourceEtag = options.sourceEtag ?? computeETag(input);
    const key = this.cache.key({
      sourceEtag,
      profileId: target.profileId,
      width: W,
      height: H,
      pixelFormat: target.pixelFormat,
      frameCodec: target.frameCodec,
      threshold,
      mode,
      autoInvert: doAutoInvert,
      letterbox,
    });
    const { data, fromCache } = await this.cache.getOrCompute(key, async () => {
      const rendered = await runSharpPipeline(input, {
        W,
        H,
        mode,
        threshold,
        doAutoInvert,
        letterbox,
      });
      assertFrameSize(rendered, target);
      return rendered;
    });
    assertFrameSize(data, target);

    return { data, width: W, height: H, fromCache };
  }

  validateFrameSize(buf: Buffer, target: RenderTarget): void {
    assertFrameSize(buf, target);
  }
}

async function runSharpPipeline(
  input: Buffer,
  o: {
    W: number;
    H: number;
    mode: DitherMode;
    threshold: number;
    doAutoInvert: boolean;
    letterbox: boolean;
  }
): Promise<Buffer> {
  const { data: rawGray } = await sharp(input)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(o.W, o.H, {
      fit: o.letterbox ? 'contain' : 'cover',
      background: { r: 255, g: 255, b: 255 },
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (rawGray.length !== o.W * o.H) {
    throw new ValidationError(`图片解码异常：当前 ${rawGray.length} 字节，期望 ${o.W * o.H} 字节`);
  }
  let gray: Uint8Array = new Uint8Array(rawGray.buffer, rawGray.byteOffset, rawGray.byteLength);
  if (o.doAutoInvert) gray = autoInvert(gray, o.W, o.H);
  gray = autoContrast(gray, 1);

  const packed = ditherTo1bpp(gray, o.W, o.H, { mode: o.mode, threshold: o.threshold });
  return Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
}
