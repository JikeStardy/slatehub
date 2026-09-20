#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScriptLogger, formatScriptError } from './helpers/script-logger';
import type { SlateHubJob } from './lib/job';

const logger = createScriptLogger('SlateHubJobRunner');
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_JOB_DIR = 'scripts/jobs';

let stopping = false;
let wakeSleep: (() => void) | null = null;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      wakeSleep = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

export interface RunnerConfig {
  jobID: string;
  intervalSeconds: number;
  runOnce: boolean;
}

export function validateJobID(jobID: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobID)) {
    throw new Error(`Invalid SLATEHUB_JOB=${jobID}. Use a scripts/jobs/<name>.ts basename.`);
  }
}

export function readRunnerConfig(env: Record<string, string | undefined>): RunnerConfig {
  const jobID = String(env.SLATEHUB_JOB ?? '').trim();
  if (!jobID) {
    throw new Error('Missing required environment variable SLATEHUB_JOB');
  }
  validateJobID(jobID);

  return {
    jobID,
    intervalSeconds: readPositiveIntValue(
      env.SLATEHUB_JOB_INTERVAL_SECONDS,
      DEFAULT_INTERVAL_SECONDS,
      'SLATEHUB_JOB_INTERVAL_SECONDS'
    ),
    runOnce: String(env.SLATEHUB_JOB_RUN_ONCE ?? '').trim() === '1',
  };
}

async function loadJob(jobID: string): Promise<SlateHubJob> {
  validateJobID(jobID);
  const jobDir = String(process.env.SLATEHUB_JOB_DIR ?? '').trim() || DEFAULT_JOB_DIR;
  const jobPath = resolve(jobDir, `${jobID}.ts`);
  if (!existsSync(jobPath)) {
    throw new Error(`Job file not found: ${jobPath}`);
  }
  const mod = (await import(pathToFileURL(jobPath).href)) as {
    job?: SlateHubJob;
    default?: SlateHubJob;
  };
  const job = mod.job ?? mod.default;
  if (!job || typeof job.run !== 'function') {
    throw new Error(`scripts/jobs/${jobID}.ts must export a SlateHubJob as "job" or default.`);
  }
  return {
    id: job.id || jobID,
    description: job.description || jobID,
    run: job.run,
  };
}

function readPositiveIntValue(
  rawValue: string | undefined,
  fallback: number,
  name: string
): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }

  logger.warn(`Ignoring invalid positive integer env ${name}=${raw}`);
  return fallback;
}

function registerSignalHandlers(): void {
  process.on('SIGTERM', () => {
    stopping = true;
    wakeSleep?.();
    logger.info('Received SIGTERM, stopping after current job cycle.');
  });

  process.on('SIGINT', () => {
    stopping = true;
    wakeSleep?.();
    logger.info('Received SIGINT, stopping after current job cycle.');
  });
}

async function main(): Promise<void> {
  const { jobID, intervalSeconds, runOnce } = readRunnerConfig(process.env);
  const job = await loadJob(jobID);

  logger.info(
    `Starting job ${job.id}: ${job.description}. ` +
      (runOnce ? 'run once.' : `interval=${intervalSeconds}s.`)
  );

  do {
    const startedAt = Date.now();
    try {
      await job.run();
      logger.info(`Job ${job.id} completed in ${Date.now() - startedAt}ms.`);
    } catch (error) {
      logger.error(`Job ${job.id} failed: ${formatScriptError(error, 2000)}`);
    }

    if (runOnce || stopping) break;
    await sleep(intervalSeconds * 1000);
  } while (!stopping);

  logger.info(`Job runner for ${job.id} stopped.`);
}

if (import.meta.main) {
  registerSignalHandlers();
  main().catch((error) => {
    logger.error(`Job runner failed: ${formatScriptError(error, 2000)}`);
    process.exit(1);
  });
}
