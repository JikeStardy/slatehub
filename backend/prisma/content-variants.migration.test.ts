import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  'migrations',
  '20260915000000_content_sources_and_variants',
  'migration.sql'
);

async function migrationSql(): Promise<string> {
  return readFile(migrationPath, 'utf8');
}

describe('content source and variant migration', () => {
  it('backfills device capability columns with the Note4 v2 defaults', async () => {
    const sql = await migrationSql();

    expect(sql).toContain("ADD COLUMN `board_id` VARCHAR(64) NOT NULL DEFAULT 'zectrix-note4'");
    expect(sql).toContain(
      "ADD COLUMN `display_profile_id` VARCHAR(64) NOT NULL DEFAULT 'zectrix-note4-400x300-mono'"
    );
    expect(sql).toContain('ADD COLUMN `protocol_version` INTEGER NOT NULL DEFAULT 2');
  });

  it('marks only legacy static content sources unavailable without inventing source blobs', async () => {
    const sql = await migrationSql();

    expect(sql).toMatch(
      /INSERT INTO `content_sources`[\s\S]*SELECT[\s\S]*'unavailable'[\s\S]*FROM `contents`[\s\S]*WHERE `kind` = 'image'/
    );
    expect(sql).not.toMatch(/INSERT INTO `content_sources`[\s\S]*CONCAT\([^;]+\.source/);
  });

  it('maps every legacy rendered image to a ready Note4 variant at its existing blob key', async () => {
    const sql = await migrationSql();

    expect(sql).toMatch(
      /INSERT INTO `content_variants`[\s\S]*SELECT[\s\S]*'zectrix-note4-400x300-mono'[\s\S]*'ready'[\s\S]*'mono1'[\s\S]*'raw_mono1_msb'[\s\S]*400[\s\S]*300[\s\S]*`image_etag`[\s\S]*`image_size`[\s\S]*CONCAT\(`group_id`, '\/', `id`, '\.img'\)[\s\S]*FROM `contents`/
    );
    expect(sql).toContain(
      'UNIQUE INDEX `content_variants_content_id_profile_id_key`(`content_id`, `profile_id`)'
    );
  });
});
