import { Injectable } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { DITHER_MODES, type DitherMode } from 'shared';
import { ValidationError } from '../../common/errors';

export interface ParsedContentUpload {
  hasImage: boolean;
  imageBuf: Buffer | null;
  imageMimeType?: string;
  hasAudio: boolean;
  audioBuf: Buffer | null;
  threshold?: number;
  mode?: DitherMode;
  hasFrameName: boolean;
  frameName: string | null;
}

const MODES = DITHER_MODES as readonly string[];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const DISALLOWED_IMAGE_MIME = new Set(['image/svg+xml']);

@Injectable()
export class MultipartParser {
  async parseContentUpload(req: FastifyRequest): Promise<ParsedContentUpload> {
    if (!req.isMultipart()) {
      throw new ValidationError('请求格式错误，请使用 multipart/form-data', {
        code: 'not_multipart',
      });
    }
    const result: ParsedContentUpload = {
      hasImage: false,
      imageBuf: null,
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    };
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname === 'image') {
          assertImageMime(part);
          const buf = await readLimitedFile(part, MAX_IMAGE_BYTES, '图片文件不能超过 10MB');
          result.hasImage = buf.length > 0;
          if (result.hasImage) {
            result.imageBuf = buf;
            result.imageMimeType = normalizedMime(part);
          }
        } else if (part.fieldname === 'audio') {
          assertAudioMime(part);
          const buf = await readLimitedFile(part, MAX_AUDIO_BYTES, '音频文件不能超过 5MB');
          result.hasAudio = buf.length > 0;
          if (result.hasAudio) result.audioBuf = buf;
        } else {
          part.file.resume();
        }
      } else {
        const val = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        if (part.fieldname === 'threshold' && val !== '') {
          const n = Number(val);
          if (Number.isFinite(n)) {
            result.threshold = Math.max(0, Math.min(255, n));
          }
        } else if (part.fieldname === 'mode' && MODES.includes(val)) {
          result.mode = val as DitherMode;
        } else if (part.fieldname === 'frame_name') {
          result.hasFrameName = true;
          const trimmed = val.trim().slice(0, 64);
          result.frameName = trimmed === '' ? null : trimmed;
        }
      }
    }
    return result;
  }
}

function assertImageMime(part: MultipartFile): void {
  const mime = normalizedMime(part);
  if (mime.startsWith('image/') && !DISALLOWED_IMAGE_MIME.has(mime)) return;
  part.file.resume();
  throw new ValidationError('图片字段只支持常见图片 MIME 类型', {
    code: 'invalid_file_type',
    field: 'image',
    content_type: part.mimetype,
  });
}

function assertAudioMime(part: MultipartFile): void {
  const mime = normalizedMime(part);
  if (mime.startsWith('audio/')) return;
  part.file.resume();
  throw new ValidationError('音频字段只支持音频 MIME 类型', {
    code: 'invalid_file_type',
    field: 'audio',
    content_type: part.mimetype,
  });
}

function normalizedMime(part: MultipartFile): string {
  return String(part.mimetype ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
}

async function readLimitedFile(
  part: MultipartFile,
  maxBytes: number,
  message: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of part.file) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (total > maxBytes) {
        part.file.destroy();
        throw new ValidationError(message, { code: 'file_too_large', max_bytes: maxBytes });
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    if ((err as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new ValidationError(message, { code: 'file_too_large', max_bytes: maxBytes });
    }
    throw err;
  }
  return Buffer.concat(chunks, total);
}
