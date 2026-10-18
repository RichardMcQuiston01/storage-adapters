# CLAUDE.md

Project memory for Claude Code. Read this before changing anything.

## What this is

`@richardmcquiston01/storage-adapters`: a tiny, runtime-neutral storage
adapter layer. Extracted from `dashboard-widgets-toolkit`
(`src/core/storage.ts`). See `ROADMAP.md` for the extraction plan.

## Rules

- Bun only (`bun install`, `bun run <script>`, `bunx`); never `npm`/`npx`
  locally. Lockfile `bun.lock` is committed. `npm publish` appears only in
  the release workflow, for provenance.
- Developing here needs Bun 1.4 or newer: the tests use `node:sqlite`, and older
  Bun writes a lockfile this repo's Bun cannot read. The workflows pin the
  exact version. Consumers on Bun only need 1.3 (`engines`), for `bun:sqlite`.
- Scripts: `typecheck`, `lint`, `format`, `format:check`, `test`, `build`,
  `changeset`, `version-packages`.
- Dual ESM + CommonJS output with declarations (`.d.ts`, `.d.cts`) for every
  entry. Check `require()` under Node and an ESM import before releasing.
- `src/` is runtime-neutral: no DOM, no Node, no `fetch`, no
  `localStorage` (ESLint-enforced). The core does no I/O; concrete adapters
  belong in optional subpaths or consumer code.
- Strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  ...), pinned to `~6.0.2`. Google TypeScript Style Guide, descriptive
  camelCase, typed locals.
- Functions return values the caller checks (`StoreResult`); reserve `throw`
  for programmer error. Error messages name the key and what went wrong.
- Tests: `node:test` + `node:assert`, run by `bun test`. No network.
  The real-browser tests (`test/browser-chromium.test.ts`) are skipped unless
  `TEST_CHROMIUM=1`: run them with `bun run test:browser`, which builds `dist/`
  first because the pages load the built package. `playwright-core` is pinned
  exactly so its Chromium matches CI; install it with
  `bunx playwright-core install chromium`.
- `README.md` is in `.prettierignore` so the Author, Buy Me a Coffee, License
  and Copyright sections stay byte-for-byte.
- Never write credentials or tokens into source, logs or committed files.

## Git and releases

- `dev` is the integration branch; branch features off `dev` and open PRs
  into `dev`, never `main`. Each user-facing change gets a changeset.
- Release: on `dev` run `bun run version-packages`, merge `dev` → `main`,
  tag `main` with `vX.Y.Z` matching `package.json`. The Release workflow
  (secret `NPM_TOKEN`) builds, tests and publishes with provenance.
- CI runs on PRs and pushes to `dev`/`main`.
- Workflows pin every action to a full commit SHA (with the version in a
  comment) and Bun and Deno to exact versions, so nothing CI or the release job
  runs changes without a commit. Dependabot proposes the action SHA bumps; bump
  the Bun and Deno versions by hand when you upgrade the tooling.
