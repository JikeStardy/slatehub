import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { AppError, RateLimitedError } from '../../common/errors';
import { formatError } from '../../common/utils/error-format';

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
const MAX_DURATION_SEC = 60;
const MAX_OUTPUT_BYTES = SAMPLE_RATE * 2 * MAX_DURATION_SEC;
const MAX_FFMPEG_CONCURRENCY = 2;
const FFMPEG_MISSING_RETRY_MS = 60_000;
const FFMPEG_AVAILABLE_RECHECK_MS = 5 * 60_000;
const FFMPEG_QUEUE_TIMEOUT_MS = 30_000;

export class AudioTranscodeError extends AppError {
  readonly code: string;
  readonly httpStatus = 400;
  constructor(message: string, code: string, detail?: unknown) {
    super(message, detail === undefined ? undefined : { detail });
    this.code = code;
  }
}

@Injectable()
export class AudioTranscoderService {
  private ffmpegAvailable: boolean | null = null;
  private ffmpegCheckedAt = 0;
  private activeFfmpeg = 0;
  private readonly ffmpegQueue: Array<() => boolean> = [];

  async checkFfmpegAvailable(): Promise<boolean> {
    if (
      (this.ffmpegAvailable === true &&
        Date.now() - this.ffmpegCheckedAt < FFMPEG_AVAILABLE_RECHECK_MS) ||
      (this.ffmpegAvailable === false &&
        Date.now() - this.ffmpegCheckedAt < FFMPEG_MISSING_RETRY_MS)
    ) {
      return this.ffmpegAvailable;
    }
    try {
      await execFileAsync('ffmpeg', ['-version']);
      this.ffmpegAvailable = true;
    } catch {
      this.ffmpegAvailable = false;
    }
    this.ffmpegCheckedAt = Date.now();
    return this.ffmpegAvailable;
  }

  async transcodeAudio(inputBuffer: Buffer, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
    if (!(await this.checkFfmpegAvailable())) {
      throw new AudioTranscodeError('音频处理服务不可用', 'FFMPEG_NOT_FOUND');
    }

    return this.runAudioPipeline(
      inputBuffer,
      'input.bin',
      (inputPath, outputPath) => [
        '-i',
        inputPath,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-t',
        String(MAX_DURATION_SEC),
        '-y',
        outputPath,
      ],
      opts
    );
  }

  async resamplePcm16(inputBuffer: Buffer, inputSampleRate: number): Promise<Buffer> {
    if (inputSampleRate === SAMPLE_RATE) {
      if (inputBuffer.length > MAX_OUTPUT_BYTES) {
        throw new AudioTranscodeError('音频时长超出限制', 'OUTPUT_TOO_LARGE');
      }
      return inputBuffer;
    }
    if (!(await this.checkFfmpegAvailable())) {
      throw new AudioTranscodeError('音频处理服务不可用', 'FFMPEG_NOT_FOUND');
    }

    return this.runAudioPipeline(inputBuffer, 'input.pcm', (inputPath, outputPath) => [
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(inputSampleRate),
      '-i',
      inputPath,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-t',
      String(MAX_DURATION_SEC),
      '-y',
      outputPath,
    ]);
  }

  private async runAudioPipeline(
    inputBuffer: Buffer,
    inputFileName: string,
    argsForPaths: (inputPath: string, outputPath: string) => string[],
    opts: { signal?: AbortSignal } = {}
  ): Promise<Buffer> {
    const tempDir = await mkdtemp(join(tmpdir(), 'slatehub-audio-'));
    const inputPath = join(tempDir, inputFileName);
    const outputPath = join(tempDir, 'output.pcm');

    try {
      await writeFile(inputPath, inputBuffer);
      await this.runFfmpeg(argsForPaths(inputPath, outputPath), opts);

      const outputBuffer = await readFile(outputPath);
      if (outputBuffer.length === 0) {
        throw new AudioTranscodeError('音频转码失败：输出为空', 'EMPTY_OUTPUT');
      }
      if (outputBuffer.length > MAX_OUTPUT_BYTES) {
        throw new AudioTranscodeError('音频时长超出限制', 'OUTPUT_TOO_LARGE');
      }
      return outputBuffer;
    } catch (err) {
      if (err instanceof AudioTranscodeError) throw err;
      throw new AudioTranscodeError('音频转码失败', 'TRANSCODE_FAILED', formatError(err));
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runFfmpeg(args: string[], opts: { signal?: AbortSignal } = {}): Promise<void> {
    const release = await this.acquireFfmpegSlot();
    try {
      await execFileAsync('ffmpeg', args, { timeout: 30_000, signal: opts.signal });
    } catch (err) {
      if (isMissingFfmpegError(err)) {
        this.ffmpegAvailable = false;
        this.ffmpegCheckedAt = Date.now();
      }
      throw err;
    } finally {
      release();
    }
  }

  private acquireFfmpegSlot(): Promise<() => void> {
    if (this.activeFfmpeg < MAX_FFMPEG_CONCURRENCY) {
      this.activeFfmpeg++;
      return Promise.resolve(() => this.releaseFfmpegSlot());
    }
    // 队列上限 = 并发上限 × 4。超出直接 429 fast-fail，避免突发流量把队列堆爆内存
    // 或让请求挂死 30s+。客户端按 Retry-After 重试即可。
    if (this.ffmpegQueue.length >= MAX_FFMPEG_CONCURRENCY * 4) {
      return Promise.reject(
        new RateLimitedError('音频转码繁忙，请稍后重试', { retry_after_sec: 5 })
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.activeFfmpeg++;
        resolve(() => this.releaseFfmpegSlot());
        return true;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.ffmpegQueue.indexOf(entry);
        if (index >= 0) this.ffmpegQueue.splice(index, 1);
        reject(new RateLimitedError('音频转码排队超时，请稍后重试', { retry_after_sec: 5 }));
      }, FFMPEG_QUEUE_TIMEOUT_MS);
      timer.unref?.();
      this.ffmpegQueue.push(entry);
    });
  }

  private releaseFfmpegSlot(): void {
    this.activeFfmpeg = Math.max(0, this.activeFfmpeg - 1);
    while (this.ffmpegQueue.length > 0) {
      const next = this.ffmpegQueue.shift();
      if (next?.()) return;
    }
  }
}

function isMissingFfmpegError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
