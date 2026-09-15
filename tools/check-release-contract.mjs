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

function compact(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function containsCompact(text, snippet) {
  return compact(text).includes(compact(snippet));
}

function exactOccurrences(text, snippet) {
  const compactText = compact(text);
  const compactSnippet = compact(snippet);
  let count = 0;
  let offset = 0;
  while (true) {
    const index = compactText.indexOf(compactSnippet, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + compactSnippet.length;
  }
}

function hasBoardSdkconfigCommand(workflow) {
  return containsCompact(
    workflow,
    `
      BOARD_SDKCONFIG_DEFAULTS="/tmp/slate-sdkconfig.\${{ matrix.board_id }}.defaults" &&
      printf "CONFIG_SLATE_BOARD_ID=\\"\${{ matrix.board_id }}\\"\\n" > "$BOARD_SDKCONFIG_DEFAULTS" &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" build &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" merge-bin -o "slate-\${{ matrix.board_id }}-full.bin"
    `
  );
}

const boardProfileErrors = displayRegistry.boards
  .map((board) => {
    const profile = displayRegistry.display_profiles.find(
      (candidate) => candidate.id === board.display_profile_id
    );
    if (!profile) {
      return `${board.id} references missing profile ${board.display_profile_id}`;
    }
    if (!profile.availability?.includes('production')) {
      return `${board.id} references non-production profile ${board.display_profile_id}`;
    }
    return null;
  })
  .filter(Boolean);

const realBoardIds = displayRegistry.boards.map((board) => board.id).sort();

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
  boardProfileErrors.length === 0,
  `Every BoardDefinition must reference a production-capable DisplayProfile: ${boardProfileErrors.join('; ')}.`
);

assertContract(
  sameList(firmwareBoardIds, realBoardIds) && sameList(releaseBoardIds, realBoardIds),
  `Firmware rolling and release matrices must exactly match real boards: ${realBoardIds.join(', ')}.`
);

assertContract(
  !/board_id:\s*virtual-mono-296x128/.test(workflows) &&
    !/slate-virtual-mono-296x128/.test(workflows),
  'virtual-mono-296x128 must not be a firmware matrix row or release artifact.'
);

assertContract(
  [firmwareWorkflow, releaseWorkflow].every(hasBoardSdkconfigCommand),
  'Every firmware workflow must contain the complete board sdkconfig, build, and merge-bin command chain.'
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
    /slate-\*-\$\{RELEASE_TAG\}-\*\.bin/.test(releaseWorkflow) &&
    /slate-\*-\$\{RELEASE_TAG\}-sha256\.txt/.test(releaseWorkflow),
  'GitHub Release publish step must download all board artifacts and collect board-named .bin and sha256 assets dynamically.'
);

assertContract(
  ['package.json', 'backend/package.json', 'frontend/package.json', 'shared/package.json'].every(
    (file) => exactOccurrences(releaseWorkflow, `check_package_version ${file}`) === 1
  ),
  'Release workflow must verify all package versions: root, backend, frontend, and shared.'
);

assertContract(
  ['backend', 'frontend', 'shared'].every(
    (workspace) =>
      exactOccurrences(releaseWorkflow, `check_lock_workspace_version ${workspace}`) === 1
  ),
  'Release workflow must verify backend/frontend/shared bun.lock workspace versions.'
);

assertContract(
  /CONFIG_APP_PROJECT_VER/.test(releaseWorkflow),
  'Release workflow must verify firmware CONFIG_APP_PROJECT_VER.'
);

assertContract(
  /git cat-file -t "\$RELEASE_TAG"/.test(releaseWorkflow),
  'Release workflow must require annotated tags.'
);

assertContract(
  /LATEST_TAG=.*sort -V/.test(compact(releaseWorkflow)) &&
    /\[ "\$LATEST_TAG" != "\$RELEASE_TAG" \]/.test(releaseWorkflow),
  'Release workflow must keep the highest vX.Y.Z tag safeguard.'
);

if (failures.length > 0) {
  console.error('Release contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Release contract check passed.');
