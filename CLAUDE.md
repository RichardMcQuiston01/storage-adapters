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
