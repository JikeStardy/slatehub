import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const root = new URL('..', import.meta.url);
const tool = fileURLToPath(new URL('tools/firmware-release-metadata.mjs', root));
const schemaPath = fileURLToPath(
  new URL('shared/schemas/firmware-release-metadata.schema.json', root)
);

function tempDir() {
  const dir = join(tmpdir(), `slate-firmware-release-metadata-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runTool(args) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function createFixture(dir, overrides = {}) {
  const tag = overrides.tag ?? 'v0.1.1';
  const version = overrides.version ?? '0.1.1';
  const boardId = overrides.boardId ?? 'zectrix-note4';
  const artifactName = `slate-${boardId}-${tag}-ota.bin`;
  const artifact = join(dir, artifactName);
  const output = join(dir, `slate-${boardId}-${tag}-ota.json`);
  const downloadUrl =
    overrides.downloadUrl ??
    `https://github.com/example/slate/releases/download/${tag}/${artifactName}`;
  const data = overrides.data ?? Buffer.from('ota payload');
  writeFileSync(artifact, data);

  const created = runTool([
    'create',
    '--board-id',
    boardId,
    '--version',
    version,
    '--release-tag',
    tag,
    '--artifact',
    artifact,
    '--download-url',
    downloadUrl,
    '--output',
    output,
  ]);

  return {
    artifact,
    artifactName,
    boardId,
    created,
    data,
    downloadUrl,
    output,
    tag,
    version,
  };
}

describe('firmware release metadata tool', () => {
  test('creates and verifies an OTA sidecar with file-backed size and sha256', () => {
    const dir = tempDir();
    try {
      const { artifact, artifactName, boardId, created, data, downloadUrl, output, tag, version } =
        createFixture(dir);
      assert.equal(created.status, 0, created.stderr);

      const metadata = JSON.parse(readFileSync(output, 'utf8'));
      assert.deepEqual(metadata, {
        schema_version: 1,
        product: 'slate',
        board_id: boardId,
        version,
        release_tag: tag,
        artifact: {
          kind: 'ota',
          filename: artifactName,
          size_bytes: data.byteLength,
          sha256: sha256(data),
          download_url: downloadUrl,
        },
      });

      const verified = runTool(['verify', '--metadata', output, '--artifact', artifact]);
      assert.equal(verified.status, 0, verified.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('create rejects non-HTTPS download URLs', () => {
    for (const protocol of ['http', 'ftp']) {
      const dir = tempDir();
      try {
        const artifactName = `slate-zectrix-note4-v0.1.1-ota.bin`;
        const { created } = createFixture(dir, {
          downloadUrl: `${protocol}://github.com/example/slate/releases/download/v0.1.1/${artifactName}`,
        });
        assert.notEqual(created.status, 0, `${protocol} unexpectedly passed`);
        assert.match(created.stderr, /https/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('create and verify reject an empty OTA artifact', () => {
    const dir = tempDir();
    try {
      const fixture = createFixture(dir, { data: Buffer.alloc(0) });
      assert.notEqual(fixture.created.status, 0, 'create unexpectedly accepted an empty OTA');

      const metadata = {
        schema_version: 1,
        product: 'slate',
        board_id: fixture.boardId,
        version: fixture.version,
        release_tag: fixture.tag,
        artifact: {
          kind: 'ota',
          filename: fixture.artifactName,
          size_bytes: 0,
          sha256: sha256(Buffer.alloc(0)),
          download_url: fixture.downloadUrl,
        },
      };
      writeFileSync(fixture.output, `${JSON.stringify(metadata, null, 2)}\n`);

      const verified = runTool([
        'verify',
        '--metadata',
        fixture.output,
        '--artifact',
        fixture.artifact,
      ]);
      assert.notEqual(verified.status, 0, 'verify unexpectedly accepted an empty OTA');
      assert.match(verified.stderr, /empty|size/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify rejects non-HTTPS metadata download URLs', () => {
    for (const protocol of ['http', 'ftp']) {
      const dir = tempDir();
      try {
        const { artifact, artifactName, created, output } = createFixture(dir);
        assert.equal(created.status, 0, created.stderr);

        const metadata = JSON.parse(readFileSync(output, 'utf8'));
        metadata.artifact.download_url = `${protocol}://github.com/example/slate/releases/download/v0.1.1/${artifactName}`;
        writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);

        const verified = runTool(['verify', '--metadata', output, '--artifact', artifact]);
        assert.notEqual(verified.status, 0, `${protocol} unexpectedly passed`);
        assert.match(verified.stderr, /https/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('create and verify reject download URLs with a trailing slash', () => {
    const dir = tempDir();
    try {
      const artifactName = 'slate-zectrix-note4-v0.1.1-ota.bin';
      const trailingSlashUrl =
        `https://github.com/example/slate/releases/download/v0.1.1/${artifactName}/`;
      const rejectedCreate = createFixture(dir, { downloadUrl: trailingSlashUrl });
      assert.notEqual(rejectedCreate.created.status, 0, 'create accepted a trailing slash URL');

      const fixture = createFixture(dir);
      assert.equal(fixture.created.status, 0, fixture.created.stderr);
      const metadata = JSON.parse(readFileSync(fixture.output, 'utf8'));
      metadata.artifact.download_url = trailingSlashUrl;
      writeFileSync(fixture.output, `${JSON.stringify(metadata, null, 2)}\n`);

      const verified = runTool([
        'verify',
        '--metadata',
        fixture.output,
        '--artifact',
        fixture.artifact,
      ]);
      assert.notEqual(verified.status, 0, 'verify accepted a trailing slash URL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects virtual or non-production board ids', () => {
    const dir = tempDir();
    try {
      const artifact = join(dir, 'slate-virtual-mono-296x128-v0.1.1-ota.bin');
      writeFileSync(artifact, 'ota');

      const result = runTool([
        'create',
        '--board-id',
        'virtual-mono-296x128',
        '--version',
        '0.1.1',
        '--release-tag',
        'v0.1.1',
        '--artifact',
        artifact,
        '--download-url',
        'https://github.com/example/slate/releases/download/v0.1.1/slate-virtual-mono-296x128-v0.1.1-ota.bin',
        '--output',
        join(dir, 'sidecar.json'),
      ]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /production board/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects versions outside the bounded X.Y.Z contract', () => {
    const invalidVersions = ['1.2', '1.2.3-alpha', `${'1'.repeat(64)}.2.3`];
    for (const version of invalidVersions) {
      const dir = tempDir();
      try {
        const fixture = createFixture(dir, {
          version,
          tag: `v${version}`,
        });
        assert.notEqual(fixture.created.status, 0, `${version} unexpectedly passed`);
        assert.match(fixture.created.stderr, /version/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('verify fails closed when the OTA file no longer matches metadata', () => {
    const dir = tempDir();
    try {
      const tag = 'v0.1.1';
      const version = '0.1.1';
      const boardId = 'zectrix-note4';
      const artifactName = `slate-${boardId}-${tag}-ota.bin`;
      const artifact = join(dir, artifactName);
      const output = join(dir, `slate-${boardId}-${tag}-ota.json`);
      const downloadUrl = `https://github.com/example/slate/releases/download/${tag}/${artifactName}`;
      writeFileSync(artifact, 'original');

      const created = runTool([
        'create',
        '--board-id',
        boardId,
        '--version',
        version,
        '--release-tag',
        tag,
        '--artifact',
        artifact,
        '--download-url',
        downloadUrl,
        '--output',
        output,
      ]);
      assert.equal(created.status, 0, created.stderr);

      writeFileSync(artifact, 'tampered');
      const verified = runTool(['verify', '--metadata', output, '--artifact', artifact]);
      assert.notEqual(verified.status, 0);
      assert.match(verified.stderr, /sha256|size/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify rejects metadata with missing or extra fields', () => {
    const cases = [
      {
        name: 'missing top-level field',
        mutate(metadata) {
          delete metadata.product;
        },
      },
      {
        name: 'extra top-level field',
        mutate(metadata) {
          metadata.extra = true;
        },
      },
      {
        name: 'missing artifact field',
        mutate(metadata) {
          delete metadata.artifact.sha256;
        },
      },
      {
        name: 'extra artifact field',
        mutate(metadata) {
          metadata.artifact.extra = true;
        },
      },
    ];

    for (const testCase of cases) {
      const dir = tempDir();
      try {
        const { artifact, created, output } = createFixture(dir);
        assert.equal(created.status, 0, created.stderr);

        const metadata = JSON.parse(readFileSync(output, 'utf8'));
        testCase.mutate(metadata);
        writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);

        const verified = runTool(['verify', '--metadata', output, '--artifact', artifact]);
        assert.notEqual(verified.status, 0, testCase.name);
        assert.match(verified.stderr, /exactly/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('schema requires all sidecar fields and rejects extra properties', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

    assert.deepEqual(schema.required, [
      'schema_version',
      'product',
      'board_id',
      'version',
      'release_tag',
      'artifact',
    ]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.version.maxLength, 63);
    assert.equal(schema.properties.release_tag.maxLength, 64);
    assert.deepEqual(schema.properties.artifact.required, [
      'kind',
      'filename',
      'size_bytes',
      'sha256',
      'download_url',
    ]);
    assert.equal(schema.properties.artifact.properties.download_url.pattern, '^https://');
    assert.equal(schema.properties.artifact.additionalProperties, false);
  });
});
