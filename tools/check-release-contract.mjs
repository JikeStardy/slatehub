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

function stepBlock(workflow, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(
    new RegExp(
      `\\n\\s*- name: ${escapedName}\\n([\\s\\S]*?)(?=\\n\\s*- name: |\\n\\s*- uses: |\\n\\s{2}[a-zA-Z0-9_-]+:|$)`
    )
  );
  return match?.[1] ?? '';
}

function hasBoardSdkconfigCommand(workflow) {
  const block = stepBlock(workflow, 'ESP-IDF build');
  return containsCompact(
    block,
    `
      BOARD_SDKCONFIG_DEFAULTS="/tmp/slate-sdkconfig.\${{ matrix.board_id }}.defaults" &&
      printf "CONFIG_SLATE_BOARD_ID=\\"\${{ matrix.board_id }}\\"\\n" > "$BOARD_SDKCONFIG_DEFAULTS" &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" build &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" merge-bin -o "slate-\${{ matrix.board_id }}-full.bin" &&
      cp build/slate.bin "build/slate-\${{ matrix.board_id }}-ota.bin"
    `
  );
}

const releaseTagOrderingBlock = stepBlock(releaseWorkflow, 'Validate release tag ordering');
const repositoryVersionsBlock = stepBlock(releaseWorkflow, 'Validate repository versions');
const tagChangelogBlock = stepBlock(releaseWorkflow, 'Read tag changelog');
const publishReleaseBlock = stepBlock(releaseWorkflow, 'Publish GitHub Release');

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
    /find "\$FIRMWARE_DIR"/.test(publishReleaseBlock) &&
    /slate-\*-\$\{RELEASE_TAG\}-\*\.bin/.test(publishReleaseBlock) &&
    /slate-\*-\$\{RELEASE_TAG\}-sha256\.txt/.test(publishReleaseBlock) &&
    /ASSETS=\("\$\{FIRMWARE_ASSETS\[@\]\}" "\$\{ASSETS\[@\]\}"\)/.test(publishReleaseBlock),
  'GitHub Release publish step must download all board artifacts and collect board-named .bin and sha256 assets dynamically.'
);

assertContract(
  ['package.json', 'backend/package.json', 'frontend/package.json', 'shared/package.json'].every(
    (file) => exactOccurrences(repositoryVersionsBlock, `check_package_version ${file}`) === 1
  ),
  'Release workflow must verify all package versions: root, backend, frontend, and shared.'
);

assertContract(
  ['backend', 'frontend', 'shared'].every(
    (workspace) =>
      exactOccurrences(repositoryVersionsBlock, `check_lock_workspace_version ${workspace}`) === 1
  ),
  'Release workflow must verify backend/frontend/shared bun.lock workspace versions.'
);

assertContract(
  containsCompact(
    repositoryVersionsBlock,
    `
      value="$(jq -r '.version' "$file")"
      if [ "$value" != "$RELEASE_VERSION" ]; then
        echo "$file version must be $RELEASE_VERSION, got $value." >&2
        exit 1
      fi
    `
  ),
  'Release workflow package version helper must read .version with jq, compare to RELEASE_VERSION, and exit 1 on mismatch.'
);

assertContract(
  /awk -v workspace=/.test(repositoryVersionsBlock) &&
    /' bun\.lock/.test(repositoryVersionsBlock) &&
    /in_workspace &&/.test(repositoryVersionsBlock) &&
    /if \[ "\$value" != "\$RELEASE_VERSION" \]; then/.test(repositoryVersionsBlock) &&
    /bun\.lock workspace \$workspace version must be \$RELEASE_VERSION/.test(
      repositoryVersionsBlock
    ) &&
    containsCompact(
      repositoryVersionsBlock,
      `
        if [ "$value" != "$RELEASE_VERSION" ]; then
          echo "bun.lock workspace $workspace version must be $RELEASE_VERSION, got
      `
    ) &&
    /exit 1/.test(
      repositoryVersionsBlock.slice(
        repositoryVersionsBlock.indexOf('if [ "$value" != "$RELEASE_VERSION" ]; then')
      )
    ),
  'Release workflow lock helper must read workspace versions from bun.lock, compare to RELEASE_VERSION, and exit 1 on mismatch.'
);

assertContract(
  containsCompact(
    repositoryVersionsBlock,
    `
      FW_VERSION="$(sed -n 's/^CONFIG_APP_PROJECT_VER="\\([^"]*\\)"/\\1/p' firmware/sdkconfig.defaults | head -n 1)"
      if [ "$FW_VERSION" != "$RELEASE_VERSION" ]; then
        echo "firmware/sdkconfig.defaults CONFIG_APP_PROJECT_VER must be $RELEASE_VERSION, got $FW_VERSION." >&2
        exit 1
      fi
    `
  ),
  'Release workflow must read firmware CONFIG_APP_PROJECT_VER, compare to RELEASE_VERSION, and exit 1 on mismatch.'
);

assertContract(
  containsCompact(
    tagChangelogBlock,
    `
      if [ "$(git cat-file -t "$RELEASE_TAG")" != "tag" ]; then
        echo "Release tag must be an annotated tag with a changelog body." >&2
        exit 1
      fi
    `
  ),
  'Release workflow must require annotated tags inside Read tag changelog.'
);

assertContract(
  containsCompact(
    releaseTagOrderingBlock,
    [
      "LATEST_TAG=\"$(git tag --list 'v*' | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -V | tail -n 1)\"",
      'if [ "$LATEST_TAG" != "$RELEASE_TAG" ]; then',
      'echo "Release tag must be the newest vX.Y.Z tag before publishing the latest image. Latest tag is ${LATEST_TAG}, got ${RELEASE_TAG}." >&2',
      'exit 1',
      'fi',
    ].join('\n')
  ),
  'Release workflow must keep the highest vX.Y.Z tag safeguard inside Validate release tag ordering.'
);

if (failures.length > 0) {
  console.error('Release contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Release contract check passed.');
