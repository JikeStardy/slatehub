#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

const firmwareWorkflow = read('.github/workflows/firmware.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const ciWorkflow = read('.github/workflows/ci.yml');
const packageJson = JSON.parse(read('package.json'));
const displayRegistry = JSON.parse(read('shared/src/display-profiles.json'));
const workflows = `${firmwareWorkflow}\n${releaseWorkflow}`;

const failures = [];

function assertContract(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function matrixBoardIds(workflow) {
  return [...workflow.matchAll(/board_id:\s*([a-z0-9-]+)/g)].map((match) => match[1]);
}

const productionBoardIds = displayRegistry.boards
  .filter((board) => {
    const profile = displayRegistry.display_profiles.find(
      (candidate) => candidate.id === board.display_profile_id
    );
    return profile?.availability?.includes('production');
  })
  .map((board) => board.id)
  .sort();

const firmwareBoardIds = matrixBoardIds(firmwareWorkflow).sort();
const releaseBoardIds = matrixBoardIds(releaseWorkflow).sort();

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

assertContract(
  /check:release-contract/.test(ciWorkflow) && /check:release-contract/.test(releaseWorkflow),
  'CI and release quality gates must run bun run check:release-contract.'
);

assertContract(
  packageJson.scripts?.['check:release-contract'] === 'node tools/check-release-contract.mjs',
  'package.json must expose check:release-contract without adding runtime dependencies.'
);

assertContract(
  sameList(firmwareBoardIds, productionBoardIds) && sameList(releaseBoardIds, productionBoardIds),
  `Firmware rolling and release matrices must match production boards: ${productionBoardIds.join(', ')}.`
);

assertContract(
  !/board_id:\s*virtual-mono-296x128/.test(workflows) &&
    !/slate-virtual-mono-296x128/.test(workflows),
  'virtual-mono-296x128 must not be a firmware matrix row or release artifact.'
);

assertContract(
  [firmwareWorkflow, releaseWorkflow].every(
    (workflow) =>
      /CONFIG_SLATE_BOARD_ID=.*\$\{\{\s*matrix\.board_id\s*\}\}/.test(workflow) &&
      /SDKCONFIG_DEFAULTS=.*board/.test(workflow) &&
      /idf\.py\s+-D\s+SDKCONFIG_DEFAULTS=/.test(workflow)
  ),
  'Every firmware workflow must pass matrix board id through an ESP-IDF sdkconfig defaults file.'
);

assertContract(
  !/printf\s+'CONFIG_SLATE_BOARD_ID=/.test(workflows),
  'ESP-IDF action commands must avoid single-quoted printf snippets that can break shell wrapping.'
);

assertContract(
  !/merge-bin -o "build\/slate-/.test(workflows) &&
    [firmwareWorkflow, releaseWorkflow].every((workflow) =>
      /merge-bin -o "slate-\$\{\{\s*matrix\.board_id\s*\}\}-full\.bin"/.test(workflow)
    ),
  'idf.py merge-bin output must use the build-relative firmware file name, not a nested build/ path.'
);

assertContract(
  /slate-\$\{\{\s*matrix\.board_id\s*\}\}-full/.test(firmwareWorkflow) &&
    /slate-\$\{\{\s*matrix\.board_id\s*\}\}-ota/.test(firmwareWorkflow),
  'Rolling firmware artifact names must include the board id.'
);

assertContract(
  /slate-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-full\.bin/.test(releaseWorkflow) &&
    /slate-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-ota\.bin/.test(releaseWorkflow) &&
    /slate-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-sha256\.txt/.test(releaseWorkflow),
  'Release firmware asset names must include board id and release tag.'
);

assertContract(
  /pattern:\s*slate-release-firmware-\*/.test(releaseWorkflow) &&
    /merge-multiple:\s*true/.test(releaseWorkflow) &&
    /find "\$FIRMWARE_DIR"/.test(releaseWorkflow) &&
    /slate-\*-\$\{RELEASE_TAG\}-\*.bin/.test(releaseWorkflow),
  'GitHub Release publish step must download all board artifacts and collect board-named assets dynamically.'
);

assertContract(
  /git cat-file -t "\$RELEASE_TAG"/.test(releaseWorkflow) &&
    /sort -V/.test(releaseWorkflow) &&
    /CONFIG_APP_PROJECT_VER/.test(releaseWorkflow) &&
    /check_package_version package\.json/.test(releaseWorkflow) &&
    /check_lock_workspace_version shared/.test(releaseWorkflow),
  'Annotated-tag, highest-version, and repository version consistency safeguards must remain present.'
);

if (failures.length > 0) {
  console.error('Release contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Release contract check passed.');
