#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

const firmwareWorkflow = read('.github/workflows/firmware.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const dockerWorkflow = read('.github/workflows/docker.yml');
const ciWorkflow = read('.github/workflows/ci.yml');
const packageJson = JSON.parse(read('package.json'));
const displayRegistry = JSON.parse(read('shared/src/display-profiles.json'));
const workflows = `${firmwareWorkflow}\n${releaseWorkflow}`;
const retiredArtifactPrefix = ['s', 'late-'].join('');
const retiredConfigPrefix = ['CONFIG_', 'SLATE'].join('');

const failures = [];

function assertContract(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function matrixBoardIds(workflow, jobName) {
  const jobs = yamlMappingBlock(workflow, 'jobs');
  const firmwareJob = yamlMappingBlock(jobs, jobName);
  const strategy = yamlMappingBlock(firmwareJob, 'strategy');
  const matrix = yamlMappingBlock(strategy, 'matrix');
  const include = yamlMappingBlock(matrix, 'include');
  return yamlSequenceRows(include).map((row) => yamlScalar(row, 'board_id'));
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
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    return '';
  }

  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent === indent && line.trimStart().startsWith('- ')) {
      break;
    }
    end += 1;
  }
  return lines.slice(start + 1, end).join('\n');
}

function directYamlKeyIndexes(lines, key) {
  const structuralLines = lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (structuralLines.length === 0) {
    return [];
  }

  const directIndent = Math.min(
    ...structuralLines.map((line) => line.length - line.trimStart().length)
  );
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ line }) =>
        line.length - line.trimStart().length === directIndent &&
        new RegExp(`^${escapedKey}:`).test(line.trimStart())
    )
    .map(({ index }) => index);
}

function yamlBlockScalar(block, key) {
  const lines = block.split('\n');
  const keyIndexes = directYamlKeyIndexes(lines, key);
  if (keyIndexes.length !== 1) {
    return '';
  }
  const start = keyIndexes[0];
  if (!new RegExp(`^\\s*${key}:\\s*[>|][+-]?(?:[1-9])?\\s*$`).test(lines[start])) {
    return '';
  }

  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.length - line.trimStart().length;
    if (line.trim() && !line.trimStart().startsWith('#') && lineIndent <= indent) {
      break;
    }
    end += 1;
  }
  return lines.slice(start + 1, end).join('\n');
}

function yamlMappingBlock(block, key) {
  const lines = block.split('\n');
  const keyIndexes = directYamlKeyIndexes(lines, key);
  if (keyIndexes.length !== 1) {
    return '';
  }
  const start = keyIndexes[0];
  if (lines[start].trim() !== `${key}:`) {
    return '';
  }

  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.length - line.trimStart().length;
    if (line.trim() && !line.trimStart().startsWith('#') && lineIndent <= indent) {
      break;
    }
    end += 1;
  }
  return lines.slice(start + 1, end).join('\n');
}

function yamlScalar(block, key) {
  const lines = block.split('\n');
  const keyIndexes = directYamlKeyIndexes(lines, key);
  if (keyIndexes.length !== 1) {
    return '';
  }
  const prefix = `${key}:`;
  return lines[keyIndexes[0]].trimStart().slice(prefix.length).trim();
}

function yamlSequenceRows(block) {
  const lines = block.split('\n');
  const structuralLines = lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (structuralLines.length === 0) {
    return [];
  }

  const directIndent = Math.min(
    ...structuralLines.map((line) => line.length - line.trimStart().length)
  );
  const starts = lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ line }) =>
        line.length - line.trimStart().length === directIndent && /^-\s+/.test(line.trimStart())
    )
    .map(({ index }) => index);

  return starts.map((start, rowIndex) => {
    const end = starts[rowIndex + 1] ?? lines.length;
    const firstValue = lines[start].trimStart().replace(/^-\s+/, '');
    const normalizedFirstLine = `${' '.repeat(directIndent + 2)}${firstValue}`;
    return [normalizedFirstLine, ...lines.slice(start + 1, end)].join('\n');
  });
}

function shellFunctionBlocks(script, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = script.matchAll(
    new RegExp(`(?:^|\\n)([ \\t]*)${escapedName}\\(\\) \\{([\\s\\S]*?)\\n\\1\\}`, 'g')
  );
  return [...matches].map((match) => match[2]);
}

function shellFunctionHeaderCount(script, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...script.matchAll(new RegExp(`(?:^|\\n)\\s*${escapedName}\\(\\)\\s*\\{`, 'g'))].length;
}

function hasBoardSdkconfigCommand(workflow) {
  const block = stepBlock(workflow, 'ESP-IDF build');
  const withBlock = yamlMappingBlock(block, 'with');
  const command = yamlBlockScalar(withBlock, 'command');
  return (
    yamlScalar(block, 'uses') === 'espressif/esp-idf-ci-action@v1' &&
    containsCompact(
      command,
      `
      BOARD_SDKCONFIG_DEFAULTS="/tmp/slatehub-sdkconfig.\${{ matrix.board_id }}.defaults" &&
      printf "CONFIG_SLATEHUB_BOARD_ID=\\"\${{ matrix.board_id }}\\"\\n" > "$BOARD_SDKCONFIG_DEFAULTS" &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" build &&
      idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$BOARD_SDKCONFIG_DEFAULTS" merge-bin -o "slatehub-\${{ matrix.board_id }}-full.bin" &&
      cp build/slatehub.bin "build/slatehub-\${{ matrix.board_id }}-ota.bin"
    `
    )
  );
}

const releaseTagOrderingBlock = stepBlock(releaseWorkflow, 'Validate release tag ordering');
const repositoryVersionsBlock = stepBlock(releaseWorkflow, 'Validate repository versions');
const tagChangelogBlock = stepBlock(releaseWorkflow, 'Read tag changelog');
const prepareFirmwareAssetsBlock = stepBlock(releaseWorkflow, 'Prepare firmware assets');
const uploadFirmwareArtifactsBlock = stepBlock(releaseWorkflow, 'Upload firmware artifacts');
const publishReleaseBlock = stepBlock(releaseWorkflow, 'Publish GitHub Release');
const rollingUploadFirmwareBlock = stepBlock(firmwareWorkflow, 'upload firmware');
const packageVersionFunctions = shellFunctionBlocks(
  repositoryVersionsBlock,
  'check_package_version'
);
const lockWorkspaceVersionFunctions = shellFunctionBlocks(
  repositoryVersionsBlock,
  'check_lock_workspace_version'
);
const packageVersionFunction = packageVersionFunctions[0] ?? '';
const lockWorkspaceVersionFunction = lockWorkspaceVersionFunctions[0] ?? '';
const packageVersionFunctionCount = shellFunctionHeaderCount(
  repositoryVersionsBlock,
  'check_package_version'
);
const lockWorkspaceVersionFunctionCount = shellFunctionHeaderCount(
  repositoryVersionsBlock,
  'check_lock_workspace_version'
);

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

const firmwareBoardIds = matrixBoardIds(firmwareWorkflow, 'build').sort();
const releaseBoardIds = matrixBoardIds(releaseWorkflow, 'firmware').sort();

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runNodeScript(script, args) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runFirmwareMetadataFixture() {
  const boardId = realBoardIds[0];
  const tag = 'v9.8.7';
  const version = '9.8.7';
  const dir = mkdtempSync(join(tmpdir(), 'slatehub-release-contract-'));
  const artifactName = `slatehub-${boardId}-${tag}-ota.bin`;
  const artifact = join(dir, artifactName);
  const metadata = join(dir, `slatehub-${boardId}-${tag}-ota.json`);
  const downloadUrl = `https://github.com/example/slatehub/releases/download/${tag}/${artifactName}`;

  try {
    writeFileSync(artifact, 'contract ota fixture');
    const create = runNodeScript('tools/firmware-release-metadata.mjs', [
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
      metadata,
    ]);
    if (create.status !== 0) {
      return `create failed: ${create.stderr || create.stdout}`;
    }

    const sidecar = JSON.parse(readFileSync(metadata, 'utf8'));
    if (
      sidecar.board_id !== boardId ||
      sidecar.artifact?.filename !== basename(artifact) ||
      sidecar.artifact?.download_url !== downloadUrl
    ) {
      return 'create wrote an unexpected sidecar payload.';
    }

    const verify = runNodeScript('tools/firmware-release-metadata.mjs', [
      'verify',
      '--metadata',
      metadata,
      '--artifact',
      artifact,
    ]);
    if (verify.status !== 0) {
      return `verify failed: ${verify.stderr || verify.stdout}`;
    }

    const virtualArtifact = join(dir, 'slatehub-virtual-mono-296x128-v9.8.7-ota.bin');
    writeFileSync(virtualArtifact, 'virtual ota fixture');
    const virtualCreate = runNodeScript('tools/firmware-release-metadata.mjs', [
      'create',
      '--board-id',
      'virtual-mono-296x128',
      '--version',
      version,
      '--release-tag',
      tag,
      '--artifact',
      virtualArtifact,
      '--download-url',
      `https://github.com/example/slatehub/releases/download/${tag}/${basename(virtualArtifact)}`,
      '--output',
      join(dir, 'virtual.json'),
    ]);
    if (virtualCreate.status === 0) {
      return 'virtual-mono-296x128 unexpectedly produced release metadata.';
    }

    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const firmwareMetadataFixtureError = runFirmwareMetadataFixture();

function runLockWorkspaceVersionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'slatehub-lock-version-contract-'));

  function runHelper(lockfile, workspace = '__root__') {
    writeFileSync(join(dir, 'bun.lock'), lockfile);
    return spawnSync(
      'bash',
      [
        '-c',
        `
          set -euo pipefail
          RELEASE_VERSION=0.2.0
          check_lock_workspace_version() {
          ${lockWorkspaceVersionFunction}
          }
          check_lock_workspace_version ${workspace}
        `,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
      }
    );
  }

  const completeLockfile = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "slatehub",
      "version": "0.2.0"
    },
    "backend": {
      "name": "backend",
      "version": "0.2.0"
    },
    "frontend": {
      "name": "frontend",
      "version": "0.2.0"
    },
    "shared": {
      "name": "shared",
      "version": "0.2.0"
    }
  },
  "packages": {}
}
`;
  const staleRootLockfile = completeLockfile.replace('"version": "0.2.0"', '"version": "0.1.1"');
  const missingRootLockfile = completeLockfile.replace('      "version": "0.2.0"\n', '');

  try {
    const root = runHelper(completeLockfile);
    if (root.status !== 0) {
      return `root workspace check failed on matching version: ${root.stderr || root.stdout}`;
    }

    for (const workspace of ['backend', 'frontend', 'shared']) {
      const result = runHelper(completeLockfile, workspace);
      if (result.status !== 0) {
        return `${workspace} workspace check failed on matching version: ${
          result.stderr || result.stdout
        }`;
      }
    }

    const staleRoot = runHelper(staleRootLockfile);
    if (
      staleRoot.status === 0 ||
      !/bun\.lock workspace __root__ version must be 0\.2\.0/.test(staleRoot.stderr)
    ) {
      return 'stale root workspace version was not rejected with the expected error.';
    }

    const missingRoot = runHelper(missingRootLockfile);
    if (missingRoot.status === 0 || !/got missing/.test(missingRoot.stderr)) {
      return 'missing root workspace version was not rejected with the expected error.';
    }

    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lockWorkspaceVersionFixtureError = runLockWorkspaceVersionFixture();

assertContract(
  /check:release-contract/.test(ciWorkflow) && /check:release-contract/.test(releaseWorkflow),
  'CI and release quality gates must run bun run check:release-contract.'
);

assertContract(
  packageJson.scripts?.['check:release-contract'] === 'node tools/check-release-contract.mjs',
  'package.json must expose check:release-contract without adding runtime dependencies.'
);

assertContract(
  packageJson.scripts?.['test:release-metadata'] ===
    'node --test tools/firmware-release-metadata.test.mjs',
  'package.json must expose the complete firmware release metadata regression suite.'
);

assertContract(
  [ciWorkflow, dockerWorkflow, firmwareWorkflow].every(
    (workflow) =>
      /push:\s*\n\s+branches:\s*\[dev\]/.test(workflow) &&
      !/branches:\s*\[master\]/.test(workflow)
  ),
  'Every rolling branch workflow must trigger on dev only.'
);

assertContract(
  /pull_request:\s*\n\s+branches:\s*\[dev\]/.test(ciWorkflow),
  'CI pull requests must target dev only.'
);

assertContract(
  /type=raw,value=dev/.test(dockerWorkflow) &&
    !/type=raw,value=master/.test(dockerWorkflow),
  'Docker rolling builds must publish the dev tag only.'
);

assertContract(
  /bun run test:release-metadata/.test(ciWorkflow) &&
    /bun run test:release-metadata/.test(releaseWorkflow),
  'CI and release quality gates must run the complete firmware release metadata regression suite.'
);

const firmwareHostTestCommands = [
  /cmake -S firmware\/host_tests -B "\$RUNNER_TEMP\/firmware-host-tests"/,
  /cmake --build "\$RUNNER_TEMP\/firmware-host-tests"/,
  /ctest --test-dir "\$RUNNER_TEMP\/firmware-host-tests" --output-on-failure/,
];
assertContract(
  firmwareHostTestCommands.every(
    (pattern) => pattern.test(ciWorkflow) && pattern.test(releaseWorkflow)
  ),
  'CI and release quality gates must compile and run every firmware host contract test.'
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
    !/slatehub-virtual-mono-296x128/.test(workflows),
  'virtual-mono-296x128 must not be a firmware matrix row or release artifact.'
);

assertContract(
  [dockerWorkflow, releaseWorkflow].every((workflow) =>
    /IMAGE:\s*ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/slatehub/.test(workflow)
  ),
  'Docker rolling and release workflows must publish ghcr.io/${owner}/slatehub images.'
);

assertContract(
  !workflows.includes(retiredArtifactPrefix) && !workflows.includes(`${retiredConfigPrefix}_`),
  'Firmware and release workflows must not contain retired artifact or board CONFIG prefixes.'
);

assertContract(
  [firmwareWorkflow, releaseWorkflow].every(hasBoardSdkconfigCommand),
  'Every firmware workflow must contain the complete board sdkconfig, build, and merge-bin command chain.'
);

assertContract(
  !new RegExp(`printf\\s+'${retiredConfigPrefix}_BOARD_ID=`).test(workflows),
  'ESP-IDF action commands must avoid single-quoted printf snippets that can break shell wrapping.'
);

assertContract(
  !new RegExp(`merge-bin -o "build/${retiredArtifactPrefix}`).test(workflows) &&
    [firmwareWorkflow, releaseWorkflow].every((workflow) =>
      /merge-bin -o "slatehub-\$\{\{\s*matrix\.board_id\s*\}\}-full\.bin"/.test(workflow)
    ),
  'idf.py merge-bin output must use the build-relative firmware file name, not a nested build/ path.'
);

assertContract(
  /slatehub-\$\{\{\s*matrix\.board_id\s*\}\}-full/.test(firmwareWorkflow) &&
    /slatehub-\$\{\{\s*matrix\.board_id\s*\}\}-ota/.test(firmwareWorkflow),
  'Rolling firmware artifact names must include the board id.'
);

assertContract(
  /name:\s*slatehub-firmware-\$\{\{\s*matrix\.board_id\s*\}\}/.test(rollingUploadFirmwareBlock),
  'Rolling firmware upload artifact name must use the slatehub prefix and board id.'
);

assertContract(
  /slatehub-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-full\.bin/.test(releaseWorkflow) &&
    /slatehub-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-ota\.bin/.test(releaseWorkflow) &&
    /slatehub-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-ota\.json/.test(releaseWorkflow) &&
    /slatehub-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-sha256\.txt/.test(releaseWorkflow),
  'Release firmware asset names must include board id and release tag, including the OTA metadata sidecar.'
);

assertContract(
  /pattern:\s*slatehub-release-firmware-\*/.test(releaseWorkflow) &&
    /merge-multiple:\s*true/.test(releaseWorkflow) &&
    /find "\$FIRMWARE_DIR"/.test(publishReleaseBlock) &&
    /slatehub-\*-\$\{RELEASE_TAG\}-\*\.bin/.test(publishReleaseBlock) &&
    /slatehub-\*-\$\{RELEASE_TAG\}-ota\.json/.test(publishReleaseBlock) &&
    /slatehub-\*-\$\{RELEASE_TAG\}-sha256\.txt/.test(publishReleaseBlock) &&
    /ASSETS=\("\$\{FIRMWARE_ASSETS\[@\]\}" "\$\{ASSETS\[@\]\}"\)/.test(publishReleaseBlock),
  'GitHub Release publish step must download all board artifacts and collect board-named .bin, OTA metadata, and sha256 assets dynamically.'
);

assertContract(
  [
    /OTA_METADATA_NAME="slatehub-\$\{BOARD_ID\}-\$\{RELEASE_TAG\}-ota\.json"/,
    /node tools\/firmware-release-metadata\.mjs create/,
    /--board-id "\$BOARD_ID"/,
    /--version "\$\{RELEASE_TAG#v\}"/,
    /--release-tag "\$RELEASE_TAG"/,
    /--artifact "\$RUNNER_TEMP\/\$OTA_NAME"/,
    /--download-url "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/releases\/download\/\$\{RELEASE_TAG\}\/\$\{OTA_NAME\}"/,
    /--output "\$RUNNER_TEMP\/\$OTA_METADATA_NAME"/,
    /node tools\/firmware-release-metadata\.mjs verify/,
    /--metadata "\$RUNNER_TEMP\/\$OTA_METADATA_NAME"/,
  ].every((pattern) => pattern.test(prepareFirmwareAssetsBlock)),
  'Release firmware preparation must create and verify OTA metadata with the checked-in tool.'
);

assertContract(
  /steps\.package\.outputs\.ota_metadata_name/.test(uploadFirmwareArtifactsBlock),
  'Release firmware artifact upload must include the OTA metadata sidecar.'
);

assertContract(
  firmwareMetadataFixtureError === null,
  `Firmware release metadata tool must create and verify controlled fixtures and reject virtual boards: ${firmwareMetadataFixtureError}.`
);

assertContract(
  ['package.json', 'backend/package.json', 'frontend/package.json', 'shared/package.json'].every(
    (file) => exactOccurrences(repositoryVersionsBlock, `check_package_version ${file}`) === 1
  ),
  'Release workflow must verify all package versions: root, backend, frontend, and shared.'
);

assertContract(
  ['__root__', 'backend', 'frontend', 'shared'].every(
    (workspace) =>
      exactOccurrences(repositoryVersionsBlock, `check_lock_workspace_version ${workspace}`) === 1
  ),
  'Release workflow must verify root/backend/frontend/shared bun.lock workspace versions.'
);

assertContract(
  packageVersionFunctionCount === 1 &&
    packageVersionFunctions.length === 1 &&
    containsCompact(
      packageVersionFunction,
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
  lockWorkspaceVersionFunctionCount === 1 &&
    lockWorkspaceVersionFunctions.length === 1 &&
    /local lock_workspace="\$workspace"/.test(lockWorkspaceVersionFunction) &&
    containsCompact(
      lockWorkspaceVersionFunction,
      `
      if [ "$workspace" = "__root__" ]; then
        lock_workspace=""
      fi
    `
    ) &&
    /awk -v workspace=/.test(lockWorkspaceVersionFunction) &&
    /awk -v workspace="\\"\$lock_workspace\\":"/.test(lockWorkspaceVersionFunction) &&
    /' bun\.lock/.test(lockWorkspaceVersionFunction) &&
    /in_workspace &&/.test(lockWorkspaceVersionFunction) &&
    /bun\.lock workspace \$workspace version must be \$RELEASE_VERSION/.test(
      lockWorkspaceVersionFunction
    ) &&
    containsCompact(
      lockWorkspaceVersionFunction,
      `
        if [ "$value" != "$RELEASE_VERSION" ]; then
          echo "bun.lock workspace $workspace version must be $RELEASE_VERSION, got \${value:-missing}." >&2
          exit 1
        fi
      `
    ),
  'Release workflow lock helper must read workspace versions from bun.lock, compare to RELEASE_VERSION, and exit 1 on mismatch.'
);

assertContract(
  lockWorkspaceVersionFixtureError === null,
  `Release workflow lock helper must reject stale or missing root workspace versions: ${lockWorkspaceVersionFixtureError}.`
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
