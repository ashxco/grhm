# CLAUDE.md — GRHM implementation notes

Guidance for agents working in this repository. The product spec is `PRD.md`; the user-facing overview is `README.md`. Do not create additional markdown files.

## What this is

The v0.2 reference implementation of GRHM: a Lisp-shaped programming language for full-stack web applications. The client compiles to React + TypeScript + CSS (history routing, per-page `React.lazy` code splitting, page titles, toasts, dialog focus trap); `(db ...)`/`(api ...)`/`(uploads)` declarations compile to a standalone hardened `node:http` + `node:sqlite` API server (`src/gen/server.ts`, Node builtins only, requires Node >= 22.13) with additive migrations, seeds, indexes, soft foreign keys (`:references`), input contracts, sessions/auth (`(auth users)`, scrypt + HttpOnly cookies, builtin `/api/auth/*` routes), CSRF (`x-grhm` header), an SSE change feed (`/api/_events`) driving `:live` resources, recurring `(job ...)` tasks, file uploads (`POST /api/uploads` + `/uploads/*` static, paired with the `file-input` element), rate limiting, security headers, JSON logging, `/healthz`, graceful shutdown, and SPA static fallback. It pairs a declarative UI layer with a general-purpose functional core — user-defined pure functions (`fn`, optionally typed params), lambdas, `let`, expression `if`/`cond`/`match` (exhaustive over enums), enums, records (`obj`/`get`), null safety (`or-else`/`is-null`/`not-null`), `attempt`, `fmt`, i18n (`t` + `(i18n ...)` catalogs), recursion, and a list/string/math standard library — shared between client and server via the generated `lib.ts`. Typed rows flow table -> `select` -> api -> resource -> `each`, so dotted field access is checked. Client mutations are `(send method route :prop expr...)` + `(refresh resource)`, both checked against declared api routes and their `(input ...)` contracts (E8xx codes); actions also include `toast` and `try`/`catch`. `src/eval.ts` is a pure-core interpreter behind `grhm eval`/`repl` — its semantics must mirror the compiled output exactly. TypeScript was chosen as the implementation language (PRD open decision 1) for ecosystem alignment.

## Commands

```bash
npm test                 # vitest suite (tests/*.test.ts), 194 tests
npm run check            # tsc --noEmit over src + tests
npm run build            # tsc -> dist/ (library + CLI at dist/cli.js)
npm run bench            # PRD 12.1 perf targets against dist/ (build first)
npm run evals            # corpus scorecard (examples/repairs/patches) against dist/
node dist/cli.js <cmd>   # run the CLI from the repo
```

The example app: `cd examples/store && npm install && npx grhm build`. Its `grhm` dependency is `file:../..`, so run `npm run build` at the repo root first. `npx grhm test` there runs both lowered suites: Vitest in jsdom (no browser) and Playwright against a real Vite server (requires `npx playwright install chromium` once).

CI is `.github/workflows/ci.yml`: compiler job (check/build/test/bench) + example job (fmt --check, build, full `grhm test` with a real browser).

## Architecture (compile pipeline order)

| Module | Responsibility |
| --- | --- |
| `src/lexer.ts` | Tokens with line/col/file spans; `;` comments; strings; `:keywords` |
| `src/parser.ts` | S-expressions -> canonical AST (`src/ast.ts`), error recovery |
| `src/ids.ts` | Stable node IDs: hash of parent key + semantic key. Declarations key by name, content nodes by their first string literal, the rest by op + occurrence index; explicit `:id "literal"` wins |
| `src/format.ts` | Canonical idempotent formatter + `projectNames` (compact/descriptive alias rewriting); canonical text is what revisions hash |
| `src/schema.ts` | The op registry: every operation, props, positional shape, motion props, test steps, browser globals. Checker, codegen, and `reference.ts` all consume it — extend the language here first |
| `src/project.ts` | Multi-file loader: resolves `(include ...)` recursively, detects cycles (E603), assigns IDs globally, merges files into one AST for analysis; `projectRevision` hashes all files |
| `src/analyze.ts` | AST -> `AppModel` (tokens + dark tokens, states, resources with `:poll`/`:live`, pages with `:title`, components, imports, typed fns, tables with `:optional`/`:indexed`/`:references`, seeds, apis with `(input ...)`/`:auth`, enums, envs, auth, jobs, uploads, i18n locales, tests). Tables have their own namespace so a table and the resource reading it can share a name. A post-pass synthesizes the users table and builtin `/api/auth/*` routes for `(auth ...)` |
| `src/typing.ts` | `Scope`/`VarInfo` (with `rowTable`, enum values, record `fields`), `inferInfo`/`inferType` (row provenance flows through list ops), `baseScope`, `fnScope` (pure fn bodies: typed params + fns + imports, no state), `handlerScope` (api handlers: route params + typed `body` + `user` + `env` + fns + imports), `jobScope` (job bodies: fns + imports + `env`, no request context) |
| `src/checker.ts` | Structural/reference/route/resource/type/interop/a11y validation -> structured diagnostics (`src/diagnostics.ts`, codes in `CODE_DOCS`); special forms `if`/`let`/`lambda`/`cond`/`match`/`obj`/`fmt`/`t` and fn-call arity (E112) validated in `checkExpr`; row-field and enum-member access checked (E812); server ops gated on `Ctx.inHandler` (E801-E819 for db/api/send/refresh/input/auth/i18n/match/live/jobs/uploads/references); send bodies validated against input contracts (E809); job bodies checked in `jobScope` with `inHandler`; seeds, `:references` targets, `:live`-requires-server, and locale consistency validated in `check` |
| `src/check-tests.ts` | Validates `(tests ...)` step shapes, routes, node references; `checkPureExpr` restricts `expect-eq` to literals + stdlib + fns |
| `src/codegen/` | `css.ts` (static CSS + motion keyframes + dark-token media block + toast/skeleton/dialog/input-error styles), `expr.ts` (expressions/actions/JS imports; lowers stdlib ops, lambdas, `let` IIFEs, `if`/`cond`/`match` ternary chains, `obj`/`get`/`or-else`/`attempt`/`fmt`/`t`, enum member reads to string literals, `select :where` to SQL via `genWhere`, db ops to `dbSelect`/`dbInsert`/`dbUpdate`/`dbDelete`/`apiFail`/`dbTx`, `send`/`refresh`/`toast`/`try` actions with async handlers), `tsx.ts` (JSX incl. form/dialog/tabs/menu/table/skeleton/file-input; links pushState-navigate; inputs emit constraint-validation attrs + error line; dialogs wrap in `DialogShell`; file-input lowers to `uploadFile(...).then(setter)`), `runtime.ts` (embedded runtime: resource cache with polling + `refreshResource` + shared-`EventSource` live subscriptions, CSRF `send`, `uploadFile`, history routing, toasts, `DialogShell` focus trap, plus `HELPERS_SOURCE` for the React-free `helpers.ts` shared with the server — including `matchRoute`/`safeDecode`, used by both the client router and the server's request dispatch so route matching cannot drift), `server.ts` (generates the standalone `node:http`+`node:sqlite` server: `SCHEMA` table specs + `ensureSchema` additive migrations + indexes + `REFERENCES` clauses, `SEEDS`/`applySeeds`, sessions + `authRoute` builtins, `validateInput`, SSE `/api/_events` + `broadcastChange` on every db mutation, `JOBS`/`startJobs` intervals, `UPLOADS` + `handleUpload`/`serveUpload`, security headers/CORS/rate limit/body cap/logging/healthz/graceful shutdown, SPA static fallback, `handleApi`/`resetDb` exports, test reset hook behind `GRHM_TEST_HOOKS=1`), `index.ts` (per-page modules lazy-loaded from `App.tsx`, `lib.ts` for user fns — imports `./helpers.ts` with extension since Node executes it, `i18n.ts` catalogs, page-title effects, sourcemap, `compileNodes()`/`compile()`) |
| `src/patch.ts` | Atomic revision-checked patches (`set/delete/append/insert-before/insert-after/replace/move`); `applyPatchToProject` edits across included files |
| `src/testgen.ts` | Lowers `(tests ...)` twice: Playwright spec (`data-g` locators, exact `getByRole` labels, history-route `goto`) and Vitest jsdom spec (renders real `<App/>`, pushState navigation, `fetch` stubbed to serve `public/`; full-stack apps spawn the generated server as a subprocess on an ephemeral port and forward `/api`, resetting db + resource cache per test). Steps: `visit/click/fill/press/expect-text/expect-gone/expect-node/expect-count/expect-value/expect-url/expect-eq/screenshot` (pure expressions lowered to TS with lib fn imports; `screenshot` lowers to Playwright `toHaveScreenshot` and is skipped in jsdom). `playwrightConfig(hasServer)` adds the API server webServer on port 34787 (`GRHM_API_PORT` override) with in-memory SQLite |
| `src/eval.ts` | Pure-core interpreter (`grhm eval`/`repl`): literals, stdlib ops, `fn`/`lambda`/`let`/`if`/`cond`/`match`, project fns/enums/i18n; semantics mirror the compiled TS (same coercions), enforced by a parity test in `tests/eval.test.ts` that runs both `evalExpr` and the `genExpr` lowering on the same expressions. Rejects state/resources/interop/server ops with a clear `EvalError` |
| `src/reference.ts` | Generates the model-facing spec from the schema (~2k tokens) |
| `src/references.ts` | Symbol resolution for find-references/rename: scope-aware (locals to their page, each vars to their loop), shadow-aware, cross-file |
| `src/sdk.ts` | `GrhmProject`: config, overlay files, load/compile/check/patch/format/inspect — the one place tooling talks to the compiler |
| `src/server.ts` | JSON-lines compiler server over stdio (`check/compile/inspect/patch/format/reference/codes/version`) |
| `src/lsp.ts` | LSP over stdio: diagnostics, hover (ops + expression ops + enums), completion (schema + stdlib), definition, references, rename, formatting, quickfix code actions built from diagnostic `suggestions`; realpath-normalizes URIs (macOS `/var` symlink) |
| `src/cli.ts` | `new/check/fmt/build/dev/test/eval/repl/start/ast/inspect/patch/serve/lsp/reference/codes`, all data commands with `--json`. `dev` also runs the generated API server when present: probes a free port from 8787, passes it to vite as `GRHM_API_PORT` (the scaffolded vite config proxies `/api` to it), restarts on recompile; `start` runs the generated server against built `dist/`; TS execution uses `--experimental-strip-types` unless `process.features.typescript` is set. `new` also writes a production Dockerfile |

Beyond `src/`: `corpus/` (grounding examples + repair/patch transcripts, enforced by `tests/corpus.test.ts`), `editors/vscode/` (LSP client extension, untested without VS Code), `scripts/bench.mjs` (perf targets), `scripts/evals.mjs` (corpus scorecard: compile/canonical, diagnostic quality incl. actionable metadata, patch replay).

## Invariants to preserve

- `format(parse(format(x))) === format(parse(x))` (idempotence) and parse -> format -> parse structural equality. Tests enforce both. Projections (`--compact`/`--descriptive`) must not change ASTs or IDs.
- Node IDs must survive formatting and unrelated edits. Never derive IDs from spans or absolute positions. IDs are assigned once per project (after all includes load), not per file.
- Revision = hash over the canonical formatted source of every project file; formatting must not change a program's revision.
- `compile()` emits no files when diagnostics contain errors.
- Generated output must pass `tsc --strict` — `tests/codegen.test.ts` runs tsc over real output; keep it green.
- Patches are atomic: validate the whole patched project (reload with overlaid sources + analyze + check) before returning `ok`.
- Diagnostics are data first: stable `code`, `nodeId`, `span` (with `file` in multi-file projects), `op`, `field`, `received`, `expected`, `suggestions`. Human text is a projection (`formatHuman`).
- The checker never executes user code. Interop calls are reference-checked only; `W601` marks them as validated by tsc at build time.
- `reference.ts` is generated from the schema — never hand-write op documentation that can drift.
- Corpus examples must compile with zero errors AND be canonically formatted; repair/patch transcripts are replayed by tests. When the language changes, update the corpus in the same commit.
- Motion (enter/stagger/hover) always sits behind `prefers-reduced-motion: no-preference`.

## Adding a language feature (checklist)

1. Add/extend the `OpSchema` in `src/schema.ts` (name, aliases, props, positional, children kind, doc — the doc string feeds `grhm reference` and LSP hover).
2. Handle validation in `src/checker.ts` (`checkElement` switch or `checkProps`); new diagnostic codes go in `CODE_DOCS`.
3. Lower it in `src/codegen/tsx.ts` (and `css.ts` if it has structural styles).
4. Add checker tests + codegen assertions (`tests/features.test.ts` for feature-level, `tests/codegen.test.ts` if output structure changes); update `tests/fixtures/store.grhm` and `examples/store` if it should be exercised end-to-end.
5. Add or update a `corpus/examples/` program (canonically formatted) and, if the feature has a new diagnostic, a `corpus/repairs.json` transcript.
6. Update README's language table.

## Known limitations (v0.2)

- The generated server needs Node >= 22.13 (`node:sqlite`); Node < 22.18 runs it via `--experimental-strip-types` (the CLI and generated configs pick the right invocation from `process.features.typescript`). Server-reachable generated modules (`server.ts`, `lib.ts`) import with explicit `.ts` extensions, which requires `allowImportingTsExtensions` in app tsconfigs (scaffold includes it).
- `select :where` compiles column refs + comparison/logic ops to parameterized SQL, but there are no joins or aggregations at the SQL level (compose in handler expressions via the stdlib). Migrations are additive only (new tables/columns/indexes on startup); column type changes or drops need manual SQL or a fresh db file. update/delete are `:id`-keyed only. `:references` emits `REFERENCES "t"("id")` DDL but SQLite FK enforcement stays off (soft references + checker validation); there is no cascade support.
- The `:live` SSE feed is deliberately coarse: any db mutation broadcasts one event and every live resource re-fetches (no per-table subscriptions on the client). Jobs are single-process `setInterval` tasks — no persistence, distributed scheduling, or retry semantics. Uploads write to a local directory (`GRHM_UPLOADS`, default `./uploads`) — no S3/object-store backend; the route is CSRF-checked but not auth-gated.
- `(screenshot ...)` lowers to Playwright `toHaveScreenshot`; the first run needs `--update-snapshots` to record baselines (jsdom skips the step).
- Auth is intentionally simple: email + password sessions in SQLite with scrypt hashing, one `(auth users)` per app, no roles/permissions model, no OAuth/SSO, no email verification or password reset flows.
- i18n uses the `locale` state and `{param}` templates; there is no pluralization, number/date locale formatting beyond `date-str`, or lazy catalog loading (all locales ship in one module).
- Interop is reference-checked, not type-checked, at GRHM level (`W601`); tsc validates signatures at build time. No `.d.ts` introspection.
- Expression typing is shallow-plus-rows: literals, state initializers, known op result types, and table-row provenance; other resource rows and untyped params are `unknown`. Typed fn params cover base types and table names — no generics or union types.
- `grhm test` steps are a fixed vocabulary (`visit/click/fill/press/expect-text/expect-gone/expect-node/expect-count/expect-value/expect-url/expect-eq/screenshot`); `expect-eq` covers pure expressions only — no assertions on live state or network traffic.
- `grhm eval`/`repl` cover the pure core only (by design); state, resources, interop, and server ops require a compiled app.
- LSP completion is schema-driven (ops + props), not position-type-aware; code actions are suggestion-replacement quickfixes. Rename covers states/resources/components/tokens/locals/each vars; imports and component props are deliberately not renameable (an import name doubles as the JS export name; prop call sites are keywords).
- Motion `:stagger` emits nth-child delays for the first 12 children; later children animate without extra delay.
- Occurrence-indexed IDs (nodes with no name and no string literal) still shift when a same-op sibling is inserted before them; explicit `:id` is the mitigation for patch-heavy flows (the corpus patch transcripts model this).
- The VS Code extension is a standard `vscode-languageclient` wrapper but has not been launch-tested in an actual VS Code instance.
- Versions in `src/scaffold.ts` templates are pinned to what this repo has installed; keep them in sync with root `package.json`.

## Conventions

- Strict TS, `noUncheckedIndexedAccess`; ESM with `.js` import suffixes (NodeNext).
- Exhaustive switches over unions end with a `never` check.
- Imports at top of file; no inline imports.
- Only two markdown files: `README.md` and this file. Update, don't add.
