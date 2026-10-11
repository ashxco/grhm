# GRHM

**GRHM** (Generative Reactive Hypermedia Metalanguage, pronounced "Graham") is a compact, Lisp-shaped programming language for machine-authored full-stack web applications. It pairs a declarative UI layer with a general-purpose functional core — user-defined pure functions (optionally typed), lambdas, `let` bindings, conditionals, pattern matching, enums, records, recursion, and a list/string/math standard library — plus first-class database tables (with seeds, indexes, and additive migrations), HTTP APIs with declared input contracts, sessions and authentication, and internationalization. One program compiles to conventional React + TypeScript + CSS on Vite (history routing, per-page code splitting) and a dependency-free Node API server with production safeguards backed by SQLite. This repository contains the v0.2 reference implementation of the language, compiler, tooling, and CLI described in [PRD.md](./PRD.md).

```text
LLM or developer -> .grhm source -> canonical AST -> checker -> React/TS/CSS + node:http/SQLite server -> Vite + node -> browser
```

## Why

Models generate verbose framework code and make locally plausible but structurally invalid edits. GRHM inverts the workflow:

- **Semantic density** — one `(btn "Shop" (click (nav "/products")))` instead of component boilerplate.
- **Machine-first diagnostics** — every error is a structured, versioned record with a stable code, node ID, source span, received/expected values, and repair suggestions.
- **Stable node identity** — every semantic node has a deterministic ID that survives formatting and unrelated edits; content nodes are keyed by their text so inserting a sibling does not shift identities.
- **Structural patching** — programs are modified with atomic, revision-checked patches against node IDs, not whole-file rewrites. Patches work across multi-file projects.
- **Conventional output** — the compiler emits readable, strict-mode TypeScript/React/CSS that builds with ordinary tooling and can be maintained by hand if you stop using GRHM.
- **Self-describing** — `grhm reference` prints a schema-generated language reference to give coding agents the compiler’s operation vocabulary.

## Quick start

```bash
npm install
npm run build

# create and run a project
node dist/cli.js new my-app
cd my-app
npm install
npm run dev        # compile + vite dev server with hot reload
```

A working example lives in [`examples/store`](./examples/store) — a four-page product catalog spanning six `.grhm` files, with an async resource, shared cart state, routing with parameters, components, design tokens, a cart dialog, tabs, a sortable table, catalog sorting written as GRHM functions, a newsletter form, motion, JavaScript interop, a SQLite-backed wishlist (database table, CRUD API, and mutations all declared in GRHM), and a browser test suite that exercises the full stack.

## The language in one example

```lisp
(app store
  (theme (token primary "#4f46e5"))

  (data
    (resource products "/api/products.json" :default (arr)))

  (state cart-count 0)

  (state sort-key "name")

  (fn by-key (key items)
    (sort-by (lambda (p) (if (= key "name") p.name p.price)) items))

  (use "./lib/pricing.ts" (import discounted))

  (include "components.grhm")

  (page "/" home
    (v :pad 32 :gap 24 :enter fade-up
      (heading "New arrivals")
      (grid :cols 4 :cols-sm 1 :gap 16
        (each p (by-key sort-key products.data)
          (product-card :name p.name :price (discounted p.price)
            :on-view (nav (path "/products/{id}" :id p.id)))))))

  (tests
    (test "home renders"
      (visit "/")
      (expect-text "New arrivals"))))
```

Core concepts:

| Concept | Forms |
| --- | --- |
| Layout | `v`/`vstack`, `h`/`hstack`, `grid`, `section`, `scroll`, `card`, `spacer` |
| Content | `txt`/`text`, `heading`, `img`/`image`, `link`, `list`, `money` |
| Interaction | `btn`/`button`, `input`, `checkbox`, `select` with `(click ...)` / `(change ...)` |
| Widgets | `form` (with `(submit ...)`), `dialog :open state`, `tabs`/`tab`, `menu`/`item`, `table`/`col` |
| Composition | `page`, `component`, `props`, `slot`, `each`, `if`, `when` |
| Modules | `(include "file.grhm")` — multi-file programs with cycle detection |
| State & data | `state` (app-wide), `local`, `resource` (async, cached, with `data`/`loading`/`error`, optional `:poll seconds`, `:live true` for push updates) |
| Live data | `(resource name "/api/x" :live true)` — the generated server exposes a server-sent-events change feed (`/api/_events`); committed changes are coalesced, and resources reading affected tables re-fetch without repeatedly aborting in-flight work |
| Database | `(db (table name (id auto) (col string\|number\|boolean :default v :optional true :indexed true :references other-table)...) (seed table (row :col v ...)))` — SQLite behind the generated server, with transactional startup migrations and enforced foreign keys |
| Jobs | `(job name :every seconds expr)` — recurring server task; the body is one server expression (db ops, fns, `env`) run on an interval with errors logged, never fatal |
| Uploads | `(uploads :max-kb n :quota-mb n :user-quota-mb n [:public true])` + `(file-input :label "Photo" :to url-state)` — the picker uploads to the builtin `POST /api/uploads` (CSRF-checked, quota-capped, owner-only when auth is enabled) and writes the returned `/uploads/...` URL into state |
| API | `(api (get "/api/x" handler) ...)` with `get`/`post`/`put`/`delete`, optional `(input (field type [:optional true :min n :max n :integer true :min-len n :max-len n :format email\|uuid\|url])...)` contracts (validated at compile time and at runtime with structured 400s) and `:auth true` guards; handlers are expressions over route params, `body`, `user`, `env`, fns, and the server ops `select` (with `:where`/`:order`/`:limit`/`:offset` compiled to SQL), `insert`, `update`, `delete-row`, `fail`, `tx` — the whole stdlib works server-side |
| Auth | `(auth users [:provider "./identity.ts"])` — synthesizes the users table, sessions (scrypt + HttpOnly cookies), and builtin `/api/auth/signup\|login\|logout\|logout-all\|me` routes; guarded handlers see `user` |
| Mutations | `(send post\|put\|delete route :prop expr...)` + `(refresh resource-name)` — checked against declared api routes and their input contracts; CSRF-protected via a custom header |
| Enums & typing | `(enum status open closed)`, read as `status.open`; typed fn params `(fn f ((x number)) ...)`; inferred nullable values, list elements, record fields, and function signatures/results; table rows flow through `select`, resources, and `each` |
| i18n | `(i18n (locale en (msg key "Hi, {name}!")) ...)` + `(t key :name expr)`; keys checked, locales checked for consistency, `locale` state switches at runtime |
| Interop | `(use "pkg-or-./path" (import name) (import-default name))`, `(call fn args...)`, browser globals (`localStorage`, `fetch`, ...) |
| Actions | `(set target value)`, `(nav ...)`, `(call ...)`, `(send ...)`, `(refresh ...)`, `(toast "msg" :tone success\|error\|info)`, `(try action... (catch action...))` |
| Style | keyword props (`:pad`, `:gap`, `:bg`, `:radius`, ...), responsive `-sm`/`-md` suffixes, `$token` references, `(dark (token ...))` overrides |
| Motion | `:enter fade\|fade-up\|scale-in\|slide-*` with `:dur`/`:delay`/`:ease`, `:stagger` child sequences, `:hover lift\|grow\|dim` gestures — all reduced-motion safe |
| Functions | `(fn name (a b) body)` — pure, recursive, first-class; `(lambda (x) ...)`, `(let ((x e)) body)`, expression `(if c a b)`, `(cond (test v)... (else v))`, `(match x (lit v)... (else v))` (exhaustive over enums); conditions must be boolean (`(not-null x)`, `(!= n 0)`, `(> (count xs) 0)`) — a non-boolean test is `E111` with a quick fix; compiled to a shared `lib.ts` |
| Stdlib | lists: `map filter find some every reduce sort-by reverse take drop nth first last append contains range sum count`; strings: `concat upper lower trim split join replace starts-with ends-with slice to-str fmt`; math: `mod abs round floor ceil sqrt pow min max random to-fixed to-num` (`to-num` returns `number \| null` — `null` wherever JavaScript `Number(x)` would be `NaN`, such as `"abc"` or a record, while `""`, `null` and booleans coerce to `0`/`1`; `to-fixed` takes numeric operands only); records: `obj get`; null safety: `or-else is-null not-null`; errors: `attempt` (operations that can throw warn `W801` outside it); dates: `now date-str` |
| Extended stdlib | records: `keys values entries from-entries assoc dissoc merge has-key`; JSON: `json-parse json-stringify`; lists: `flat-map flatten unique zip chunk group-by`; regex: `regex-test regex-find regex-replace`; URLs: `url-encode url-decode`; dates: `date-iso date-parse` (`date-parse` returns `number \| null`, `null` when unparseable); math: `clamp trunc sign sin cos tan asin acos atan atan2 exp log log10`. `json-parse chunk regex-* url-decode date-iso` throw on bad operands: literal operands are verified at check time, dynamic ones need `(attempt ...)` |
| Expressions | arithmetic/comparison/logic ops — inferred types, null guards, and boolean conditions (`if`/`when`/`cond` tests, `and`/`or`/`not` operands) are checked; mismatches are `E111` with wrap fixes, arity errors are `E112`; literal operands of throwing ops are verified (`E109`), dynamic ones warn `W801` with an `(attempt ...)` quick fix |
| Widgets+ | `skeleton :lines n` loading placeholders; `input` constraint validation (`:pattern :min :max :min-len :max-len :error`); dialogs have accessible names, make the background inert, trap focus, and close on Escape; menus support arrows, Home/End, typeahead and Escape; tabs use roving focus and linked panels; pages take `:title expr` |
| Tests | `(tests (test "name" (visit ...) (click ...) (fill ...) (press "Escape") (expect-text ...) (expect-gone ...) (expect-node ...) (expect-count node n) (expect-value node "v") (expect-url ...) (expect-eq expr expr) (screenshot "name")))` — `screenshot` lowers to a Playwright visual-regression assertion (`toHaveScreenshot`) |

Type inference follows values through functions, callbacks, lists, and records, including optional table fields and missing list elements. Use `is-null`/`not-null` guards or `or-else` before operations requiring a non-null value; these handle both `null` and `undefined`, while expression `= null` uses strict equality. The parsing ops `to-num` and `date-parse` are nullable and need the same guard (`(or-else (to-num s) 0)`); `NaN` is reachable only through arithmetic such as `(/ 0 0)`, and `grhm eval` prints non-finite numbers as `NaN`/`Infinity` rather than `null`. Function results and stored values retain their inferred types in generated TypeScript. The source annotation syntax still covers base types and table names; opaque interop and external resource payloads remain unknown.

SQL predicates use null-safe equality (`IS`/`IS NOT`) while retaining SQLite column affinity, so numeric IDs still match route parameter strings. `contains` is a case-sensitive, literal substring search: `%`, `_`, and backslashes have no wildcard meaning. Needles use JavaScript string coercion, and a null haystack does not match. Ordering comparisons with null retain SQL's three-valued logic; use explicit null checks when that distinction matters.

Resource consumers sharing a URL share one request and one polling timer, using the fastest active interval. Explicit refresh cancels an older request; removing the last consumer stops polling and cancels pending work. Unused entries expire after 30 seconds, with a limit of 128 unused URLs; mounted resources remain cached. Responses from superseded requests cannot overwrite newer data.

## CLI

```text
grhm new <name>          create a project
grhm check [--json]      parse + validate; structured diagnostics
grhm fmt [--check]       canonical formatting (CI-friendly)
     [--compact|--descriptive]  rewrite op names to that projection
grhm build [--json]      compile, strictly typecheck, and bundle with Vite
grhm dev                 compile, watch all project files, serve with HMR
                         (starts the generated API server too when the app has (db ...)/(api ...))
grhm test [--unit|--e2e] lower (tests ...) to Vitest (jsdom) + Playwright and run both
grhm eval "<expr>"       evaluate a pure-core expression (project fns/enums/i18n available)
grhm repl                interactive evaluator for the pure core
grhm start               run the production server (generated API + built dist/)
grhm ast --json          canonical AST with stable node IDs
grhm inspect --node <id> one node subtree, parent context, and file
grhm patch <file>        apply an atomic structural patch
grhm fix [--dry-run]     apply the safe fixes diagnostics carry (--level review, --fix <id>,
                         --code <CODE>, --revision <rev>, --no-format)
grhm serve               long-lived compiler server (JSON lines on stdio)
grhm lsp                 language server (LSP over stdio)
grhm reference [--full]  compact agent reference or detailed operation docs
grhm codes [CODE]        list all diagnostic codes, or explain one with worked repairs
```

`grhm build` requires local TypeScript and Vite. It typechecks application sources and every generated module, including backend modules in custom output directories, before bundling. A missing test runner makes `grhm test` fail; use `--unit` or `--e2e` to select the intended suite.

Exit codes: `0` success, `1` validation failure (`grhm fix` that leaves errors behind, `grhm codes` given an unknown code), `2` build/config failure (including bad `grhm fix` flags), `3` internal error.

## Diagnostics

Every diagnostic is machine-readable first; human output is a projection:

```json
{
  "schema": 1,
  "code": "E102",
  "severity": "error",
  "message": "\"text\" has no property \":colr\"",
  "nodeId": "b2fh9k1",
  "op": "text",
  "field": "colr",
  "expected": "align bg color gap pad ...",
  "suggestions": [":color"],
  "fixes": [
    {
      "id": "f7c2a91e3",
      "title": "Replace \":colr\" with \":color\"",
      "confidence": "safe",
      "edits": [{ "file": "pages/home.grhm", "start": 301, "end": 306, "text": ":color" }]
    }
  ],
  "span": { "line": 12, "col": 18, "start": 301, "end": 306, "file": "pages/home.grhm" }
}
```

`suggestions` are display hints. `fixes` are machine-applicable repairs: the `id` is `f` followed by eight hex digits — a content hash of the title, confidence, and the edits' offsets and text, so the same repair offered by two diagnostics shares one id and an id is valid only against the text it was computed on; each edit holds UTF-16 offsets into the file's current text (`start === end` inserts, empty `text` deletes); and the confidence tier says how much trust it deserves — `safe` is the unique mechanical correction (a unique nearest spelling within two edits of a misspelt name of four or more characters, or one edit of a three-character name — one- and two-character names never qualify — or a declaration the program provably needs), `review` clears the diagnostic but encodes a choice (a fallback value, a tied spelling), and `placeholder` inserts a stand-in the author must fill in. At most one fix per diagnostic is `safe`. The LSP offers every fix as a quick fix and marks the safe one as preferred.

`grhm fix` applies them to the project (`grhm check` ends with `N safe fix(es) available: grhm fix` when there are any). It works in passes: diagnose, pick one fix per diagnostic (the unique fix at or below `--level`, default `safe`; ties are skipped as `ambiguous`), apply the non-conflicting batch, reload, and keep the result only if the program still parses and every applied fix removed the diagnostic it claimed. Fixing one diagnostic routinely reveals the next, so passes repeat until nothing more applies; safe fixes land before review fixes so the consequences of a typo disappear before any fallback is inserted. `--fix <id>` applies a specific fix of any confidence, including placeholders, exactly once; `--code E102` restricts bulk fixing to a code (explicit `--fix` ids are exempt); `--revision` is the same precondition the patch protocol uses; `--dry-run` reports without writing (its `--json` result carries the `newSource`/`newSources` text it would have written); `--no-format` keeps every changed file minimally edited. Otherwise changed files are re-canonicalized when they were canonical before and minimally edited (comments survive) when they were not. A program that does not parse is refused with `E503`: the parser's `E002`/`E003` fixes are review quick fixes for the editor, so a stray or missing parenthesis is repaired by hand or through the LSP first. The `--json` result lists `applied` fixes (code, file:line:col, title, pass), `skipped` ones with a reason (`ambiguous`, `deferred`, `ineffective`, `broke-parse`, `invalid-edit`), `uncovered` errors that fixing revealed, the remaining `diagnostics` with fix ids valid for the next request, and why it `stopped` (`fixed-point`, `max-passes` only when eligible fixes remained, `cycle`); it exits 0 only when the program is clean afterwards. An interop module that was already missing (`E602`) does not block fixing and is reported with the remaining diagnostics; a fix or patch that would introduce one is rejected. The compiler server answers the same request as `fix` (with `preview: true` for a dry run).

The agent loop is check, fix, re-check: `grhm check --json` reports diagnostics with their fixes, `grhm fix --json` (or `--fix <id>` for a chosen one) applies them and returns the remaining diagnostics, and fix ids are bound to the text they were computed on, so always take them from the latest result. Two checks go beyond spelling and shape. Conditions (`if`/`when`/`cond` tests and `and`/`or`/`not` operands) must infer to boolean: a nullable, numeric, string, or list test is `E111` with a wrap fix (`(or-else b false)`, `(!= n 0)`, `(!= s "")`, `(not-null x)`, `(> (count xs) 0)`). Operations that can throw (`json-parse`, `chunk`, `regex-test`/`regex-find`/`regex-replace`, `url-decode`, `date-iso`) have their literal operands verified at check time (`E109`), while a dynamic operand outside `(attempt ...)`, a pure `fn` body, or `expect-eq` warns `W801` with a placeholder `(attempt ... fallback)` fix. A `fn` whose body has such an unguarded operation (directly or through the fns it calls) is quiet itself but warns at every call outside `attempt`, with the wrap on the call; arguments are not inlined, so a call with literal arguments warns too. Spelling fixes draw only on the names valid in their position (no bare enum as a value, no declaration or action op in element position), and a slot that takes a state reference or an action form (`dialog :open`, `file-input :to`, `update :id`, route params, `action` props) gets no placeholder.

Codes are stable (`E1xx` structure/types, `E2xx` references/routes, `W3xx`/`W4xx` quality and accessibility, `E5xx` patching and fixing, `E6xx` interop/includes, `E7xx` tests, `E8xx` database/api, `W8xx` runtime safety). Run `grhm codes` for the full list; `grhm codes E111` explains one code with its worked repairs from the corpus (every code the compiler can emit for a single-file program has at least one; the project loader's filesystem checks `E602`/`W602`/`E603`, the patch and fix codes `E5xx`/`W501`, and the `E900` error envelope are exempt — see `UNREPRODUCIBLE_CODES` in `tests/corpus.test.ts`), and an unknown code exits 1 with a did-you-mean.

## Patch protocol

Programs are edited structurally, atomically, and with optimistic concurrency:

```lisp
(patch :revision "f581c7ca" :target 146stiw
  (set cols 3)
  (append (txt "Sale ends Sunday"))
  (insert-before (spacer 8))
  (move :before other-node-id))
```

- The `:revision` precondition rejects patches against stale program states (the revision is a hash of the canonical formatted source of every project file, so formatting never invalidates it).
- All operations apply or none do; a patch that would produce an invalid program is rejected with the diagnostics it would have caused.
- Targets may live in any included file; only the files that changed are rewritten.
- Results report the new revision, changed node IDs, and changed files.

## Tooling for agents and editors

- **Compiler server** (`grhm serve`) — a long-lived process that answers `check`, `compile`, `inspect`, `patch`, `fix`, `format`, `reference`, `codes` (optionally with a `code` to explain), and `version` requests as JSON lines over stdio, avoiding process-startup latency in agent loops.
- **LSP** (`grhm lsp`) — diagnostics on open/change, quick fixes from diagnostic `fixes` (the safe one preferred), hover documentation, completion, go-to-definition, find-references, rename (scope-aware, shadow-aware, cross-file), and canonical formatting.
- **VS Code extension** ([`editors/vscode`](./editors/vscode)) — syntax highlighting plus an LSP client that starts `grhm lsp` for the workspace.
- **Model-facing reference** (`grhm reference`) — signatures generated from the compiler schema, tested below 4,000 tokens with both `cl100k_base` and `o200k_base`. Use `--full` for detailed operation descriptions. The CLI token estimate remains an approximation.
- **Grounding corpus** ([`corpus/`](./corpus)) — small canonical example programs covering every primitive, plus diagnostic-repair and patch-usage transcripts. The test suite compiles every example and replays every transcript (repairs that declare a `fix` level must replay through `grhm fix` to the documented program, the rest must not become auto-fixable unnoticed, and every diagnostic code a single-file `compile()` can emit must have a repair — the filesystem, include, patch/fix, and internal-error codes listed in `UNREPRODUCIBLE_CODES` are exempt), so the corpus cannot drift from the compiler and `grhm codes <CODE>` has a worked example for every compiler code.
- **Projections** (`grhm fmt --compact|--descriptive`) — the same program rendered with terse (`v`, `txt`, `btn`) or descriptive (`vstack`, `text`, `button`) op names; both parse to identical ASTs and IDs.

## Generated output

`grhm build` emits into `src/gen/`:

| File | Contents |
| --- | --- |
| `pages/*.tsx` | One module per page (kebab-cased page name) |
| `components.tsx` | Typed component functions and props interfaces |
| `state.ts` | Shared stores for app-level state and enum bindings |
| `App.tsx` | History router with per-page `React.lazy` code splitting, Suspense fallback, document titles, error boundary, and the toast host |
| `runtime.ts` | Stores, history routing, cached `useResource` (with polling and SSE live subscriptions) and `refreshResource`, CSRF-protected `send` mutations, `uploadFile`, toasts, dialog focus management, money formatting (dependency-free besides React) |
| `helpers.ts` | Pure stdlib helpers shared by client, `lib.ts`, and server (no React import) |
| `i18n.ts` | Message catalogs and the `tMsg` template helper (when the app declares `(i18n ...)`) |
| `server.ts` | When the app declares `(db ...)`/`(api ...)`/`(uploads)`: a standalone `node:http` + `node:sqlite` API server with additive schema migrations, seed data, indexes and foreign keys, input validation, sessions/auth (scrypt, HttpOnly cookies), CSRF checks, a server-sent-events change feed for live resources, recurring jobs, file uploads with static serving, security headers, rate limiting, JSON logging, `/healthz`, graceful shutdown, static serving of the built client with history-route fallback, and a test dispatch export — Node builtins only |
| `styles.css` | Deterministic static CSS, design tokens as CSS variables, responsive rules, reduced-motion-guarded animations |
| `sourcemap.json` | Node ID -> source file/span and generated-file correlation map |
| `tests/app.spec.ts` | Playwright browser spec lowered from `(tests ...)` (when present) |
| `tests/app.unit.test.tsx` | Vitest jsdom spec from the same suites — renders the real `<App/>` with `fetch` served from `public/` and, for full-stack apps, `/api` forwarded to the real generated server on an in-memory database |

The output passes `tsc --strict`, renders DOM nodes tagged with `data-g="<nodeId>"` for runtime-to-source correlation, and reports uncaught runtime errors as structured JSON on the console. There is no hidden framework: delete GRHM and the generated project still builds with Vite.

## Security posture

The generated server is designed around a small, auditable threat model:

- **Zero runtime dependencies.** The server uses Node builtins only (`node:http`, `node:sqlite`, `node:crypto`); the client depends on React alone. CI runs `npm audit --omit=dev` to keep the published package's production dependency surface empty.
- **Injection.** All SQL is parameterized; `select :where` compiles column references against the declared schema, so user input never reaches SQL text. JSX output escapes by construction.
- **CSRF.** Every mutation (including uploads) requires the custom `x-grhm` header, which cross-site forms cannot set; session cookies are `HttpOnly; SameSite=Lax` (add `Secure` via `GRHM_SECURE=1`).
- **Sessions & passwords.** Opaque random tokens stored as SHA-256 digests server-side and expired after `GRHM_SESSION_DAYS` (default 30, swept on read and on new-session creation); passwords hashed with async scrypt (never blocking the event loop) and compared in constant time; password hashes are stripped from every row the data layer returns. Hashing concurrency is capped at four, authentication is throttled by account and address, and each account retains at most ten sessions. `POST /api/auth/logout-all` revokes them all. Upgrading from raw session tokens signs existing sessions out.
- **Client data.** Successful builtin signup, login, and logout actions clear retained resource data and cancel old requests. A BroadcastChannel invalidates other open tabs. HTTP 401/403 responses discard previously cached data.
- **Input.** Declared `(input ...)` contracts reject non-object bodies, non-finite numbers, missing, mistyped, out-of-range, and unknown fields with structured 400s before handlers run; strings default to a 65,536-character cap unless overridden; request bodies are size-capped; malformed request paths and headers degrade gracefully rather than crashing the process.
- **Errors.** Unexpected API failures return a generic `500` response while retaining diagnostic details in structured server logs. Intentional `(fail status message)` responses preserve the declared status and message.
- **Uploads.** With auth enabled, private uploads use random names and require the owner session for reads. Public uploads require an explicit `:public true` override in auth apps; apps without auth default to public content-addressed files. Total/per-user quotas default to 1024/100 MiB and reserve space before writing, including concurrent uploads. Legacy files remain inaccessible to users in private mode until ownership is assigned by the operator. Only an image extension allowlist keeps a rendering `Content-Type`, and everything else is stored extensionless and served as a sandboxed `attachment` — so an uploaded HTML/SVG/JS file can never execute script on the app's origin.
- **Transport & headers.** `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` on every response; CORS is off unless `GRHM_CORS_ORIGIN` is set; per-IP rate limiting on `/api`; static serving is path-traversal-safe.
- **Secrets.** `(env name)` declarations are validated at startup and only readable inside server handlers — they cannot leak into client code by construction.

## Deployment and release checks

Use Node 22.22.2+ on the 22.x line, or Node 24.15+ on the 24.x line, for the application toolchain and release checks. The generated SQLite server itself requires Node 22.13+; older 22.x releases need type stripping enabled, which the CLI handles. CI checks the supported toolchain versions.

After `npm install` creates `package-lock.json`, the scaffolded Dockerfile uses `npm ci`, binds port 8787 on all container interfaces, and runs as the unprivileged `node` user. It prunes development dependencies and starts `grhm-start.mjs` directly. This launcher uses the generated API server or the standalone static server for frontend-only apps; production serving does not require Vite or the compiler. Mount a persistent volume at `/data` for both SQLite and uploads; host bind mounts must be writable by UID 1000. Runtime secrets belong in environment variables, not the image. The generated `.dockerignore` excludes environment files, local databases, and uploads.

Terminate HTTPS at a reverse proxy and retain `GRHM_SECURE=1` for secure session cookies (the container default). Allow SSE streaming without proxy buffering; the server sends 15-second heartbeats, bounds the number of streams, and disconnects slow readers. Live resources revalidate after reconnecting. Shutdown stops new jobs, waits for active jobs and requests, and has a ten-second deadline; exceeding it exits unsuccessfully. Jobs use overflow-safe timers and never overlap their own prior run. Configure the orchestrator with a longer termination grace period.

This deployment is a single-process SQLite application. `:references` is enforced at runtime; constraint conflicts return 409. Queries return at most `GRHM_MAX_ROWS` rows (default 1000); an unbounded query exceeding that budget fails with 413 instead of silently truncating. Use `select :limit` and `:offset` for pagination. Static files stream with backpressure, support HEAD/ETag, and give hashed assets immutable caching; API and private-upload responses use `Cache-Control: no-store`.

The request budget is 128 active requests (excluding SSE), a 64 MiB aggregate body budget (`GRHM_MAX_BUFFER_BYTES`), 30-second request deadlines, and 15-second header deadlines. SSE has global/per-identity limits and closes slow readers. Invalid numeric session/rate-limit settings fail startup; `GRHM_RATE_LIMIT=0` disables the general API limiter. Forwarded IP headers are ignored unless the immediate socket peer appears in `GRHM_TRUSTED_PROXIES` (comma-separated exact IPs). Only list trusted proxy peers, make the proxy overwrite incoming forwarding headers, and prevent direct access to the backend.

`/healthz` is liveness; `/readyz` checks database access, writable database/upload storage, and available filesystem blocks (the frontend server checks its index file). Every response carries `X-Request-Id`; structured request/error logs correlate that ID with the route and GRHM node. Set a high-entropy `GRHM_METRICS_TOKEN` to expose authenticated JSON metrics at `/__grhm/metrics` using `Authorization: Bearer <token>`. Metrics include route latency buckets, error counts, RSS/heap, event-loop P95/P99, active requests, and SSE clients. Protect this endpoint at the proxy as well.

### Database upgrades and recovery

Startup applies additive schema changes and numbered `migrations/<version>_<name>.sql` files in one transaction. A checksummed ledger rejects changed, missing, duplicated, or out-of-order migrations. Schema drift, removed tables/indexes, and required reference backfills require explicit SQL migrations. The runner owns transaction boundaries and PRAGMAs; migration files contain DDL/DML. Foreign-key validation must pass before commit. Seeds bootstrap each table once; deleting data does not resurrect it on restart. Changes to seed data belong in a migration.

Use `grhm migrate --check` to validate an upgrade and roll it back, then `grhm migrate` to apply it. These commands require the application's environment and interop dependencies. For a deployment without the compiler, run the generated server with `GRHM_MIGRATE=check` or `GRHM_MIGRATE=apply`; it migrates and exits without listening. Back up before schema changes:

```sh
grhm db backup ./grhm.db ./backup.db
grhm db verify ./backup.db
grhm db restore ./backup.db ./restored.db
```

Backup uses SQLite's consistent online snapshot operation, including committed WAL data. Verification runs SQLite integrity and foreign-key checks and returns a SHA-256 receipt. Restore requires a closed snapshot and a new destination, never overwrites the live database, and verifies before publication. Stop the application before switching `GRHM_DB` to the restored path. Back up the uploads directory with the database during a maintenance window so file metadata and bytes describe the same state; retain encrypted copies outside the application host. In a pruned deployment, the same commands are available through `node --experimental-strip-types src/gen/db-admin.ts`.

### Authentication and split deployments

Built-in auth is a small password/session implementation. For email verification, account recovery, MFA, or SSO, use `(auth users :provider "./identity.ts")`. The server imports that module's `authenticate(request)` function. The request has `headers`, `method`, `url`, and an abort `signal`; return `{ userId: positiveInteger }` for an existing local user, or `undefined` to deny authentication. The adapter must verify provider credentials, issuer, audience, expiry, and the stable external-identity-to-local-user mapping. Never derive a user ID directly from unverified headers or link accounts merely by an unverified email address. Provision local users through the application's trusted administrative flow. Adapter failures fail closed with 503, calls have a five-second deadline and bounded concurrency, and external SSE sessions reconnect to revalidate identity. The external provider owns signup, login, logout, verification, and recovery; local password endpoints return 501 in provider mode. `/api/auth/me` and route guards use the verified identity.

For separately hosted frontend/API origins, call `configureRuntime({ apiOrigin: 'https://api.example.com', onError })` from the generated runtime before rendering `App`. `onError` receives `{ kind, message, requestId? }`; connect it to the application's reporting service. Configure the API's `GRHM_CORS_ORIGIN` to the exact frontend origin. Cookies use credentials on resource, mutation, upload, and SSE requests; truly cross-site deployments additionally need `GRHM_SAMESITE=none` with `GRHM_SECURE=1`. Browser third-party-cookie policies may still require a same-site proxy or provider-specific flow.

Jobs remain single-process periodic tasks; they have no durable queue, distributed lease, or retry guarantees. Use an external scheduler/queue for work that must survive crashes, and make side effects idempotent. Set `GRHM_JOBS=off` on web workers, and invoke `GRHM_RUN_JOB=job-name node --experimental-strip-types src/gen/server.ts` from the scheduler; it runs the named job once, logs the outcome, closes SQLite, and exits without listening. Pass a stable scheduler run key through an `(env ...)` declaration when an external side effect needs deduplication. Uploads remain local filesystem storage. Authorization of business rows belongs in the app's guarded handlers; authenticating a user does not by itself establish ownership of every row.

Project patch and fix writes take a writer lock, compare the source snapshot before committing, and keep an fsynced recovery journal for multi-file edits. A failed write rolls back; the next writer recovers an interrupted transaction. Cooperating GRHM writers are serialized. Do not concurrently modify the same files through tools that ignore the lock. Malformed locks or abandoned recovery locks require operator inspection; never delete a lock owned by a live process.

Run `npm run release:check` after installing Chromium with `npx playwright install chromium`. It runs strict checks, the test suite, corpus scorecard, compiler and HTTP load benchmarks, site checks, browser keyboard/accessibility checks, and a packed-package install/build/restart smoke test. `npm run test:container` additionally builds the scaffolded image and verifies non-root execution and database/upload persistence through restart. CI runs these checks and the full example app browser suite. Publishing runs the release checks automatically; this does not replace reviewing application-specific security and deployment requirements.

The HTTP load gate uses 10,000 mixed reads/writes at concurrency 32 by default; tune `GRHM_LOAD_REQUESTS`, `GRHM_LOAD_CONCURRENCY`, and `GRHM_LOAD_P99_MS` for deployment hardware. Its results are synthetic regression measurements, not a capacity claim for arbitrary apps. The corpus and seeded parity suites test compiler behavior; model-driven success rates still require a separately designed blind evaluation with a chosen model and representative application tasks.

## Versioning and stability

GRHM follows semver from `0.x`: breaking language or diagnostic changes bump the minor version pre-1.0 (major after), and everything else is additive.

- **Stable surfaces:** the language grammar and op vocabulary, diagnostic codes and their JSON shape (`schema: 1`), node ID derivation, the patch protocol, the compiler-server and CLI `--json` outputs, and the generated-file layout.
- **Deprecation policy:** ops and props are never removed within a minor line; deprecated forms keep compiling and emit a warning code for at least one minor version before removal.
- **The corpus is the contract:** every example and transcript in `corpus/` is compiled and replayed by the test suite, so any change that would break existing programs fails CI in this repository before it can ship.

## Development

The local marketing and documentation site lives in `site/`. Run `npm run site:dev` and open `http://127.0.0.1:4317`. Run `npm run site:sync` after compiler changes to regenerate the schema reference, downloadable examples, compiler-verified agent workflow, and compiled React demo. The agent guide at `/docs/agents` covers reference context, inspection, patches, diagnostics, verification, and the compiler server. `npm run site:check` checks example compilation, guide syntax, routes, local assets, the patch workflow (including stale and invalid patch rejection), and that the tracked operation and expression tables and the agent example match the compiler; the diagnostics table and `language-reference.txt` are regenerated by `site:sync` but not compared, so run the sync after changing a doc string or diagnostic code. Fonts and other assets are served locally; no hosting service is required.

```bash
npm test         # round-trip, IDs, checker, strict codegen, patches, corpus, interpreter/compiler parity, client lifecycle, tooling, live API server CRUD + auth + SSE/jobs/uploads
npm run test:corpus # compile and strictly typecheck every corpus app, render its pages with React, replay transcripts
npm run test:load   # mixed HTTP/SQLite load, latency/RSS/event-loop budgets
npm run test:parity # fixed regressions plus seeded evaluator/compiler comparison and failure shrinking
npm run check    # typecheck the compiler
npm run build    # emit dist/ (CLI + library)
npm run bench    # PRD 12.1 performance targets
npm run evals    # corpus scorecard: compile/canonical, diagnostic quality, fix replay (declared levels replay exactly, undeclared stay unfixed), patch replay
```

The parity suite checks 1,000 bounded expressions across five reproducible seeds, plus fixed edge cases for coercion, nulls, callbacks, Unicode, and numeric boundaries. A mismatch reports its seed, case, and minimized expression. To replay or extend a run, use `GRHM_PARITY_SEED=42 GRHM_PARITY_CASES=5000 npm run test:parity`. The parity gate derives required operation coverage from the schema. Randomness and wall-clock reads use controlled providers in fixed tests and are excluded from generated expressions.

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs the full suite plus the example app end-to-end, including the generated Playwright tests in a real browser.

Repository layout, architecture notes, and current limitations are documented in [AGENTS.md](./AGENTS.md).

## Status

v0.2 implements the language and tooling described here: a language core with user-defined (optionally typed) pure functions, lambdas, `let`, expression conditionals, `cond`/`match` (exhaustive over enums), enums, records, null safety, error handling, string templates, and a schema-defined standard library; inferred nullable, collection, record, and callable types alongside table rows flowing through `select` -> api -> resource -> `each`; declared API input contracts validated at both compile time and runtime; sessions and authentication with builtin routes; SQL query pushdown (`:where`/`:order`/`:limit`), seeds, indexes, foreign keys, additive migrations, and transactions; live data over server-sent events (`:live` resources), recurring server jobs, and file uploads; a hardened generated server (CSRF, rate limiting, security headers, logging, health, graceful shutdown); history routing with per-page code splitting, page titles, form validation, toasts, skeletons, dark tokens, and i18n; a pure-core interpreter behind `grhm eval`/`repl`; `grhm start` and a scaffolded Dockerfile for deployment; an LSP with quick-fix code actions; an expanded test vocabulary including pure-expression assertions and visual-regression screenshots; and a corpus eval harness (`npm run evals`). The benchmark gate checks a ~1,600-node program against the PRD 12.1 P50 limits: 300 ms for check/compile and 200 ms for patch validation. Run `npm run bench` for measurements on your hardware.


The PRD's comparative token-efficiency and held-out model success targets remain research goals, not demonstrated release claims. The corpus scorecard measures compiler behavior and diagnostic quality; it does not establish that agents author or repair GRHM more efficiently than equivalent React. Those claims require retained model transcripts, matched task behavior, equal context budgets, and an independently run held-out benchmark.
