# Task 3B1 report — VariantRenderService

## Scope delivered

- Added `VariantRenderService` in `backend/src/modules/rendering/variant-render.service.ts`.
- Added `RenderingModule` in `backend/src/modules/rendering/rendering.module.ts` and exported the service.
- Added focused service tests in `backend/src/modules/rendering/variant-render.service.test.ts`.
- Did not wire the service into content upload, dynamic refresh, controllers, frontend, firmware, manifest, or legacy Note4 fields.
- Did not change Prisma schema or add dependencies.

## RED evidence

Initial focused run before production implementation:

```text
bun test backend/src/modules/rendering/variant-render.service.test.ts

error: Cannot find module './variant-render.service'

0 pass
1 fail
1 error
```

Additional RED during state-machine review:

```text
bun test backend/src/modules/rendering/variant-render.service.test.ts

VariantRenderService > continues rendering later profiles when failed-state persistence fails for one profile
error: failed row db down

8 pass
1 fail
```

## GREEN evidence

Focused service tests:

```text
bun test backend/src/modules/rendering/variant-render.service.test.ts

9 pass
0 fail
27 expect() calls
```

Full backend tests:

```text
bun run --cwd backend test

229 pass
0 fail
842 expect() calls
```

Root checks:

```text
bun run typecheck
tsc --noEmit passed for frontend and backend

bun run lint
eslint --max-warnings 0 passed for frontend and backend

git diff --check
passed with no whitespace errors
```

Scoped formatting:

```text
bunx prettier --check backend/src/modules/rendering/variant-render.service.ts backend/src/modules/rendering/variant-render.service.test.ts backend/src/modules/rendering/rendering.module.ts

All matched files use Prettier code style.
```

## State-machine decisions

- Enabled profiles come only from `displayProfilesForEnvironment(config.nodeEnv)`: production renders Note4 only; development and test render Note4 plus the virtual compact profile.
- Render targets come only from Task 3A `renderTargetFromProfile`; the service validates supported mono encoding and exact target byte length before writing frame bytes.
- Each profile is attempted independently. A render or validation failure for one profile is persisted as that profile's failed/unchanged result and does not stop later profiles.
- Successful render path writes the profile-specific canonical blob key, then upserts a ready variant row with canonical target metadata, ETag, size, key, shared renderVersion, cleared error/lease, and attempts reset to zero.
- Failed render path with a previous ready row preserves ready status plus frame metadata/renderVersion/storage key, clears lease, stores bounded latest error, and increments attempts.
- Failed render path without a previous ready row upserts a failed row with canonical target metadata, bounded latest error, cleared lease, incremented attempts, and no usable frame metadata.
- If DB persistence fails after replacing a frame blob, the service restores prior bytes when available, otherwise deletes the newly written frame. The per-profile result reports unchanged ready/failed state with the DB error.
- The renderVersion is computed once per service call as max existing variant renderVersion for the content plus one, so successful and first-failed rows in the same run share one version.

## Residual risks

- The service is intentionally not integrated into upload or dynamic rendering yet, so existing content flows still use legacy image fields until later tasks wire them in.
- DB failure after blob replacement is rolled back at the blob layer, but the service does not attempt a second DB write to record that DB error because the persistence layer has already rejected the state transition.
- The final Git commit hash is reported in the task handoff rather than embedded here; embedding a commit's own SHA in the committed file would change that SHA.
