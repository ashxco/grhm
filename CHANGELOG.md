# Changelog

All notable changes to GRHM are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows the policy in [README.md](./README.md#versioning-and-stability) (semver from `0.x`: breaking language or diagnostic changes bump the minor version before 1.0).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-10-10

The v0.2 reference implementation: language, compiler, tooling, and CLI, prepared for public launch (GitHub, npm, and the documentation site).

### Added

- **Language.** A declarative UI layer (pages, layouts, forms, dialogs, tabs, menus, tables, skeletons, file inputs, motion, theme tokens with dark variants) over a general-purpose functional core: pure `fn`s with optional typed params, lambdas, `let`, expression `if`/`cond`/`match` (exhaustive over enums), enums, records (`obj`/`get`), null safety (`or-else`/`is-null`/`not-null`), `attempt`, `fmt`, i18n (`t` and `(i18n ...)` catalogs), recursion, and a list/string/math standard library shared by client and server.
- **Full stack.** `(db ...)` tables with seeds, indexes, soft `:references`, and additive migrations; `(api ...)` routes with `(input ...)` contracts and `:auth`; `(auth users)` sessions (scrypt, HttpOnly cookies, builtin `/api/auth/*` routes, pluggable identity provider); CSRF via the `x-grhm` header; an SSE change feed driving `:live` resources; recurring `(job ...)` tasks; file uploads with quotas; `(env ...)` declarations validated at startup.
- **Output.** React + TypeScript + CSS on Vite (history routing, per-page `React.lazy` code splitting, page titles, toasts, dialog focus trap) and a standalone `node:http` + `node:sqlite` API server with security headers, rate limiting, request budgets, JSON logging, `/healthz` and `/readyz`, authenticated metrics, graceful shutdown, and SPA static fallback. Zero runtime dependencies.
- **Agent tooling.** Stable node IDs, structured diagnostics (`schema: 1`, codes, spans, received/expected, suggestions), atomic revision-checked patches across multi-file projects, a schema-generated language reference, a JSON-lines compiler server, an LSP (diagnostics, hover, completion, definition, references, rename, formatting, quick fixes), and a VS Code client.
- **CLI.** `new`, `check`, `fmt`, `build`, `dev`, `test`, `eval`, `repl`, `start`, `ast`, `inspect`, `migrate`, `db`, `patch`, `fix`, `serve`, `lsp`, `reference`, `codes`; every data command supports `--json`.
- **Testing.** `(tests ...)` lowered to both Playwright and Vitest/jsdom, a corpus of grounding examples and repair/patch transcripts replayed by the test suite, interpreter/compiler parity (seeded), performance and HTTP load gates, browser accessibility checks, packed-package and container smoke tests, and the documentation site with a compiler-verified agent workflow.
- **Structured fixes and `grhm fix`** (commit `068adb4`). Diagnostics carry machine-applicable `fixes` tagged `safe`/`review`/`placeholder` with content-hashed ids; `grhm fix [--dry-run --level --fix <id> --code --revision --no-format]`, the compiler-server `fix` request, and LSP quick fixes apply them through the shared, journaled patch commit path. `grhm codes <CODE>` explains one code with its worked corpus repairs (71 transcripts).
- **Boolean conditions** (`068adb4`). `if`/`when`/`cond` tests and `and`/`or`/`not` operands must infer to boolean (E111) with wrap fixes; `and`/`or` lower to `!!(...)` so TypeScript narrows guarded values.
- **Throwing-op checks** (`068adb4`). `json-parse`, `chunk`, `regex-*`, `url-decode`, and `date-iso` are verified on literal operands at check time (E109) and warn (W801) on dynamic operands outside `(attempt ...)`, propagated through callers.
- **Nullable `to-num`** (`068adb4`). `to-num` and `date-parse` return `number | null` instead of `NaN`, mirrored in the interpreter.
- `CHANGELOG.md`, and package metadata for npm: `repository`, `homepage`, `bugs`, and `author`.
- A tag-triggered release workflow ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) that runs `release:check` and publishes to npm with provenance, and a CI job that packages the VS Code extension with `@vscode/vsce` and uploads the `.vsix`.
- `vercel.json` for the static documentation site (`site/dist`, no build step, clean URLs, history-route fallback).
- `grhm new` prints how to point a fresh project at a source checkout with a `file:` dependency when the CLI runs from one.
- Tests: `VERSION` matches `package.json`; the scaffold is canonical and passes `grhm fmt --check` and `grhm check`; `grhm check` outside a project and `grhm migrate` on a frontend-only app exit 2 with a plain message; the generated server ignores test hooks in production.

### Changed

- One Node policy everywhere (package `engines`, README, scaffold, generated server header, site): Node 22.13 or newer is required; 22.22+ or 24.15+ is recommended because those releases run the generated TypeScript without experimental flags. `engines.node` was `>=18`, which the CLI could not honour.
- The scaffold template written by `grhm new` is canonically formatted, so `grhm fmt --check` passes on a fresh project.
- The scaffolded `package.json` declares `engines.node` as `>=22.13`.
- `grhm migrate` on an app without `(db ...)`/`(api ...)`/`(uploads)` and any project command run outside a project exit 2 with a one-line explanation instead of an `E900` internal error; the Node-version floor is reported the same way.
- The VS Code extension manifest carries `repository`, `bugs`, `homepage`, and keywords, and `@vscode/vsce` is a devDependency so `npx @vscode/vsce package` works offline from a lockfile.

### Fixed

- Fresh projects install on Node 22: npm 10's peer-dependency resolver crashes (`Cannot read properties of null (reading 'edgesOut')`) when the registry's latest vitest major differs from the pinned one, so `grhm new` writes an `.npmrc` with `legacy-peer-deps=true` (npm 11+, bundled with Node 24, is fixed upstream).

### Security

- The generated server ignores `GRHM_TEST_HOOKS=1` when `NODE_ENV=production` and logs one structured `config-warning`, so the rate-limit bypass and `POST /__grhm/reset` exist only when test hooks are active outside production.


[Unreleased]: https://github.com/ashxco/grhm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ashxco/grhm/releases/tag/v0.2.0
