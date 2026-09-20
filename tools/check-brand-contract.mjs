#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
});

if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout || 'git ls-files failed.');
  process.exit(listed.status ?? 1);
}

const retiredLower = ['s', 'late'].join('');
const retiredTitle = `S${retiredLower.slice(1)}`;
const retiredWord = new RegExp(`(^|[^A-Za-z])(?:${retiredTitle}|${retiredLower})(?=$|[^A-Za-z])`);
const retiredPrefix = new RegExp(`\\b${['S', 'LATE_'].join('')}`);
const upstreamUrl = ['https://github.com/', 'qiujun8023/', retiredLower].join('');

const allowedAcknowledgementFiles = new Set(['README.md', 'NOTICE.md']);
const sourceExtensions = new Set([
  '',
  '.c',
  '.cc',
  '.cmake',
  '.cpp',
  '.css',
  '.env',
  '.example',
  '.h',
  '.hh',
  '.hpp',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const sourceBasenames = new Set([
  '.dockerignore',
  '.env.example',
  '.gitignore',
  'Dockerfile',
  'CMakeLists.txt',
  'README',
]);
const failures = [];

function report(path, reason) {
  failures.push(`${path}: ${reason}`);
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function isSkipped(path) {
  return (
    path === '' ||
    path.startsWith(`docs${sep}superpowers${sep}`) ||
    path.startsWith(`.superpowers${sep}`)
  );
}

function isTextCandidate(path) {
  const base = path.split('/').pop() ?? path;
  return sourceBasenames.has(base) || sourceExtensions.has(extname(path));
}

function hasNul(text) {
  return text.includes('\0');
}

function assertContains(path, text, snippet, reason) {
  if (!text.includes(snippet)) {
    report(path, reason);
  }
}

const paths = listed.stdout.split('\0').filter(Boolean);

for (const path of paths) {
  if (isSkipped(path)) {
    continue;
  }

  for (const part of path.split('/')) {
    if (retiredWord.test(part)) {
      report(path, `path contains retired standalone brand segment "${part}"`);
      break;
    }
  }

  if (!isTextCandidate(path)) {
    continue;
  }

  let text;
  try {
    text = read(path);
  } catch (error) {
    report(path, `cannot read file: ${error.message}`);
    continue;
  }
  if (hasNul(text)) {
    continue;
  }

  const acknowledgementAllowed = allowedAcknowledgementFiles.has(path);
  const withoutAllowedUrl = acknowledgementAllowed ? text.replaceAll(upstreamUrl, '') : text;
  const withoutNoticeTitle = acknowledgementAllowed
    ? withoutAllowedUrl
        .replaceAll(`${retiredTitle} project`, '')
        .replaceAll(`${retiredTitle} 项目`, '')
    : withoutAllowedUrl;

  if (retiredWord.test(withoutNoticeTitle)) {
    report(path, 'contains retired standalone brand name');
  }
  if (retiredPrefix.test(text)) {
    report(path, `contains retired ${['S', 'LATE_'].join('')} prefix`);
  }
  if (!acknowledgementAllowed && text.includes(upstreamUrl)) {
    report(path, 'contains retired upstream repository URL');
  }
}

assertContains(
  'package.json',
  read('package.json'),
  '"name": "slatehub"',
  'root package name must be slatehub'
);
assertContains(
  'compose.yml',
  read('compose.yml'),
  'SLATEHUB_IMAGE:-ghcr.io/jikestardy/slatehub:master',
  'compose image default must use SlateHub GHCR master channel'
);
assertContains(
  '.github/workflows/docker.yml',
  read('.github/workflows/docker.yml'),
  'IMAGE: ghcr.io/${{ github.repository_owner }}/slatehub',
  'docker workflow image must use slatehub'
);
assertContains(
  '.github/workflows/release.yml',
  read('.github/workflows/release.yml'),
  'IMAGE: ghcr.io/${{ github.repository_owner }}/slatehub',
  'release workflow image must use slatehub'
);
assertContains(
  'firmware/sdkconfig.defaults',
  read('firmware/sdkconfig.defaults'),
  `CONFIG_${['SLATEHUB', '_DEFAULT_SERVER_URL'].join('')}=""`,
  'firmware sdkconfig must expose SlateHub Kconfig keys'
);
assertContains(
  'shared/schemas/firmware-release-metadata.schema.json',
  read('shared/schemas/firmware-release-metadata.schema.json'),
  '"const": "slatehub"',
  'firmware metadata schema product must be slatehub'
);
assertContains(
  'frontend/index.html',
  read('frontend/index.html'),
  '<title>SlateHub · 墨笺</title>',
  'Web title must be SlateHub'
);

for (const path of [
  'README.md',
  'backend/README.md',
  'backend/scripts/README.md',
  'frontend/README.md',
  'shared/README.md',
  'firmware/README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
]) {
  assertContains(path, read(path), 'SlateHub', 'README surface must use SlateHub naming');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('SlateHub brand contract passed.');
