#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const registryPath = new URL('../shared/src/display-profiles.json', import.meta.url);
const schemaVersion = 1;
const product = 'slate';

function usage() {
  return [
    'Usage:',
    '  node tools/firmware-release-metadata.mjs create --board-id <id> --version <x.y.z> --release-tag <vx.y.z> --artifact <path> --download-url <url> --output <path>',
    '  node tools/firmware-release-metadata.mjs verify --metadata <path> --artifact <path>',
  ].join('\n');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(usage());
    }
    values[key.slice(2)] = value;
    index += 1;
  }
  return { command, values };
}

function requireArgs(values, names) {
  for (const name of names) {
    if (!values[name]) {
      fail(`Missing required argument --${name}.\n${usage()}`);
    }
  }
}

function readRegistry() {
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

function productionBoard(boardId) {
  const registry = readRegistry();
  const board = registry.boards.find((candidate) => candidate.id === boardId);
  if (!board) {
    return null;
  }
  const profile = registry.display_profiles.find(
    (candidate) => candidate.id === board.display_profile_id
  );
  if (!profile?.availability?.includes('production')) {
    return null;
  }
  return board;
}

function assertProductionBoard(boardId) {
  if (!productionBoard(boardId)) {
    throw new Error(`${boardId} is not a production board in shared/src/display-profiles.json.`);
  }
}

function artifactStats(path) {
  const data = readFileSync(path);
  if (data.byteLength === 0) {
    throw new Error('OTA artifact must not be empty.');
  }
  return {
    filename: basename(path),
    size_bytes: statSync(path).size,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function urlBasename(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('download URL must use https.');
    }
    if (parsed.pathname.endsWith('/')) {
      throw new Error('download URL path must end with the artifact filename.');
    }
    return basename(parsed.pathname);
  } catch {
    throw new Error(`artifact.download_url must be a valid HTTPS URL: ${rawUrl}`);
  }
}

function expectedOtaFilename(boardId, releaseTag) {
  return `slate-${boardId}-${releaseTag}-ota.bin`;
}

function validateReleasePair(version, releaseTag) {
  if (version.length > 63 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`version must match X.Y.Z, got ${version}.`);
  }
  if (releaseTag !== `v${version}`) {
    throw new Error(`release_tag must be v${version}, got ${releaseTag}.`);
  }
}

function ownKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, path) {
  const actual = ownKeys(value);
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${path} must contain exactly: ${sortedExpected.join(', ')}.`);
  }
}

function validateMetadata(metadata, artifactPath) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be a JSON object.');
  }
  assertExactKeys(
    metadata,
    ['schema_version', 'product', 'board_id', 'version', 'release_tag', 'artifact'],
    'metadata'
  );
  if (metadata.schema_version !== schemaVersion) {
    throw new Error(`schema_version must be ${schemaVersion}.`);
  }
  if (metadata.product !== product) {
    throw new Error(`product must be ${product}.`);
  }
  assertProductionBoard(metadata.board_id);
  validateReleasePair(metadata.version, metadata.release_tag);

  const artifact = metadata.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('artifact must be a JSON object.');
  }
  assertExactKeys(
    artifact,
    ['kind', 'filename', 'size_bytes', 'sha256', 'download_url'],
    'artifact'
  );
  if (artifact.kind !== 'ota') {
    throw new Error('artifact.kind must be ota.');
  }

  const expectedName = expectedOtaFilename(metadata.board_id, metadata.release_tag);
  if (artifact.filename !== expectedName) {
    throw new Error(`artifact.filename must be ${expectedName}.`);
  }
  if (urlBasename(artifact.download_url) !== artifact.filename) {
    throw new Error('artifact.download_url basename must match artifact.filename.');
  }

  const actual = artifactStats(artifactPath);
  if (actual.filename !== artifact.filename) {
    throw new Error(`artifact path basename must be ${artifact.filename}, got ${actual.filename}.`);
  }
  if (actual.size_bytes !== artifact.size_bytes) {
    throw new Error(
      `artifact.size_bytes mismatch: metadata=${artifact.size_bytes}, actual=${actual.size_bytes}.`
    );
  }
  if (actual.sha256 !== artifact.sha256) {
    throw new Error(
      `artifact.sha256 mismatch: metadata=${artifact.sha256}, actual=${actual.sha256}.`
    );
  }
}

function create(values) {
  requireArgs(values, ['board-id', 'version', 'release-tag', 'artifact', 'download-url', 'output']);
  assertProductionBoard(values['board-id']);
  validateReleasePair(values.version, values['release-tag']);

  const actual = artifactStats(values.artifact);
  const expectedName = expectedOtaFilename(values['board-id'], values['release-tag']);
  if (actual.filename !== expectedName) {
    throw new Error(`artifact filename must be ${expectedName}, got ${actual.filename}.`);
  }
  if (urlBasename(values['download-url']) !== actual.filename) {
    throw new Error('download URL basename must match artifact filename.');
  }

  const metadata = {
    schema_version: schemaVersion,
    product,
    board_id: values['board-id'],
    version: values.version,
    release_tag: values['release-tag'],
    artifact: {
      kind: 'ota',
      filename: actual.filename,
      size_bytes: actual.size_bytes,
      sha256: actual.sha256,
      download_url: values['download-url'],
    },
  };
  validateMetadata(metadata, values.artifact);
  writeFileSync(values.output, `${JSON.stringify(metadata, null, 2)}\n`);
}

function verify(values) {
  requireArgs(values, ['metadata', 'artifact']);
  const metadata = JSON.parse(readFileSync(values.metadata, 'utf8'));
  validateMetadata(metadata, values.artifact);
}

try {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === 'create') {
    create(values);
  } else if (command === 'verify') {
    verify(values);
  } else {
    fail(usage());
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
