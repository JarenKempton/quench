# Decisions

## Settled

- Build own app (not contribute to skills-manager) — differentiators: whole-context
  view, provenance/pinning, existing agentkit backend
- Tauri v2, tray + window in one binary
- Cloud: yes, optional tier (user overruled git/tailscale-only staging) — Cloudflare,
  minimal, maybe paid later
- Sources model: everything git-backed incl. invisible app-managed local repo
- Staged mutations (tray + one Apply), calm-tool UI register, no provenance dots
  (tooltips), human harness names
- Name: **Hone** (provisional — Hono proximity noted; rename cheap until launch)
- No orchestrator framing, ever
- **The project repo is itself a source** ([#9]) — every skill is
  `(source, path, pinned tree SHA)`, so skills committed into a project are just skills
  sourced from *that* project. One model, no second mechanism. Source kinds: the project
  repo · a shared team skills repo · your own private/local git repo · app-managed
  `~/.hone/local.git`.
- **Per-project state splits by owner, not by location** ([#9]):
  - **Committed `./.hone/manifest.json`** — *what's available*: source repos + the menu
    of skills drawn from them. Changing it is a PR. **Only exists if the project uses
    sources** — a team that only commits skills never sees this file.
  - **Personal `~/.hone/projects/<key>.json`** — *what you activate and what version
    you're on*. Never committed.

  Skills materialize into the **harness-native dir** (`.claude/skills/` etc., per team
  agreement). `.hone/` holds pointers, never content — there is no `.hone/skills/`
  composition folder.
- **Pins are per-skill and personal, via git tree SHAs** ([#9]) — every directory in git
  already has a content-addressed tree SHA (`git rev-parse HEAD:<path>`), so different
  skills from one repo can sit at different revisions, and a commit touching an unrelated
  skill yields an identical tree SHA (zero false-update noise). This *is* architecture.md's
  "pinned content hash". Personal pins mean teammates see "update available" and **opt in
  per skill** — nobody moves silently. Cost: per-skill pins kill the symlink trick (no
  single checkout to point at), so skills are copied out at their pinned tree and
  **ownership is recorded in the manifest, not observed**.
- **The PR is the mechanism, and it must be explicit in the UI** ([#9]) — editing or
  removing a committed project skill opens a **PR against the project repo**, batched
  across edits. Editing a source skill commits to *its* source repo. Personal deselect of
  a committed skill uses Claude Code's **`skillOverrides`** in the auto-gitignored
  `.claude/settings.local.json` (purpose-built for "skills checked into a shared project
  repo") — never `git update-index --skip-worktree`, which git's own docs say "does not
  work as expected".

- **Monorepo: desktop and cloud share one tree** ([#8]) — user overruled the
  separate-repo recommendation; the shared client/server contract won. Consequence: the
  "cloud is never load-bearing" principle is now a *discipline*, not a structural fact,
  so it needs a mechanical guardrail — `hone-core` never depends on the cloud package,
  and **the desktop app must build and run green with `apps/cloud/` deleted**. Checkable
  in CI; not yet wired.
- **Repo layout** ([#8]) — pnpm + Cargo workspaces over one tree:

  ```
  hone/
  ├── Cargo.toml              # workspace root — [profile.release] LIVES HERE
  ├── package.json            # pnpm workspace root
  ├── crates/
  │   └── hone-core/          # scanner, git, provenance — pure Rust, no Tauri
  ├── apps/
  │   ├── desktop/            # stock create-tauri-app layout, one level down
  │   │   ├── package.json    # the real frontend
  │   │   ├── index.html, vite.config.ts, src/
  │   │   └── src-tauri/      # thin: Builder, generate_context!, commands
  │   └── cloud/              # phase 3 — Workers + D1 + wrangler.toml
  └── docs/
  ```

  Cargo workspace members: `apps/desktop/src-tauri`, `crates/hone-core` (explicit, not
  globbed). No Python vendored anywhere — [#5] settled Rust-native.
- **`src-tauri/` nests inside `apps/desktop/`** ([#8]) — not hoisted to `crates/`. The
  Tauri CLI takes `$cwd` as the frontend if `$cwd` has a `package.json`, else **walks
  downward** and takes the *first* one it finds (depth 3) — so `apps/cloud/package.json`
  can silently hijack frontend detection. Running from `apps/desktop/` hits both the
  frontend and `$cwd/src-tauri` on the first try: **no `TAURI_APP_PATH` /
  `TAURI_FRONTEND_PATH` needed**, and the tree inside `apps/desktop/` is byte-identical
  to `create-tauri-app` output, so stock docs apply and the default
  `"frontendDist": "../dist"` is already correct.
- **`hone-core` split from day one** ([#8]) — a boundary that can't be accidentally
  crossed: logic there physically cannot reach `AppHandle` or Tauri state, so it stays
  pure by construction. [#5]'s port is incremental (scanner now; x-ray/apply/heartbeat
  later), so this crate is where nearly all of Hone eventually lives. Keeps a headless
  consumer possible without a rewrite — which matters because the thing Hone replaces
  (`bootstrap.sh` + `agentkit`) *is* a CLI, and [#11] must define parity against it.
  Note: the usual "you need a separate crate to unit-test" argument is **false** — Tauri
  v2 already generates `src-tauri` as lib+bin, so `cargo test` works flat. The split
  earns its place on boundary discipline, not testability.
- **pnpm, not npm workspaces** ([#8]) — npm hoists all deps into one flat root
  `node_modules/`, so `apps/desktop` could import something only `apps/cloud` declared
  (a phantom dependency) and it would just work — the exact principle-2 erosion path the
  monorepo opens. pnpm's strict symlinked `node_modules` makes a desktop→cloud import
  fail at import time, not in review. Cost: needs `corepack enable` on every machine/CI
  runner.
- **Frontend stack inside the webview** ([#7]) — React 19 + TypeScript + Vite +
  **TanStack Router** (hash history — a Tauri webview has no server to answer path-based
  deep links) + **Zustand**. Vanilla ruled out (the `invoke` switch rewrites the prior-art
  JS anyway); Next.js / TanStack Start structurally excluded (no Node server in a Tauri
  bundle); Svelte deferred.
- **Frontend toolchain: Vite+ (`vp`)** — one CLI for install/dev/build/lint/format/test,
  replacing split pnpm + Vite + tsc. Low lock-in: `vp` *wraps* pnpm (lockfile + resolution
  stay pnpm), MIT-licensed. `vite` is catalog-aliased to Vite+'s Vite-8 core, and `vp` is a
  local `node_modules/.bin`, so `tauri.conf.json`'s `pnpm dev` / `pnpm build` route to it
  with no vp-specific wiring and no global install needed to run the app. Its type-aware
  `vp check` (oxlint) is a real gate — it caught a floating promise and a missing
  `vite-env.d.ts` the plain `tsc` build had passed. Caveat: Vite+ is **beta** (v0.2.x) —
  pinned; CI would use `setup-vp`. (Refines [#7].)

### Tauri v2 facts verified for [#8] (primary sources)

- **`[profile.*]` must live at the Cargo workspace root.** Cargo *only* reads profiles
  from the workspace-root manifest ([cargo ref]); yet Tauri's own [size guide] tells you
  to put `[profile.release]` in `src-tauri/Cargo.toml`. Inside a workspace that no-ops
  with a **warning, not an error** — release builds are quietly unoptimized. Tauri's docs
  never mention this. Reproduced on cargo 1.93.0.
- **`src-tauri` as a workspace member is supported** — one line in the [project structure]
  docs. `target/` moves to the workspace root.
- **Declare `tauri = "2"` literally in `src-tauri/Cargo.toml`**, not `workspace = true` —
  the CLI cannot auto-manage its feature flags through a workspace inheritance and
  silently degrades to a notice.
- **`#[tauri::command]` fns CAN live outside `src-tauri`.** The widely-repeated claim that
  they must share a crate with `generate_handler!` is **false in v2** — verified by
  compiling against `tauri 2.11.5`. The real constraint is **visibility**: command fns
  must be `pub` (a `pub(crate)` fn fails with `error[E0603]: macro __cmd__<name> is
  private`). `generate_context!` must stay in `src-tauri` — it resolves `tauri.conf.json`
  relative to its own manifest dir. `tauri dev` watches workspace path-dependencies, so
  editing `hone-core` triggers a rebuild.
- **Don't alias commands** — `use x::greet as g; generate_handler![g]` fails; the macro
  rewrites only the last path segment ([tauri#8513], closed not-planned).

[#1]: https://github.com/JarenKempton/hone/issues/1
[#5]: https://github.com/JarenKempton/hone/issues/5
[#7]: https://github.com/JarenKempton/hone/issues/7
[#8]: https://github.com/JarenKempton/hone/issues/8
[#9]: https://github.com/JarenKempton/hone/issues/9
[#10]: https://github.com/JarenKempton/hone/issues/10
[#11]: https://github.com/JarenKempton/hone/issues/11
[#14]: https://github.com/JarenKempton/hone/issues/14
[cargo ref]: https://doc.rust-lang.org/cargo/reference/profiles.html
[size guide]: https://v2.tauri.app/concept/size/
[project structure]: https://v2.tauri.app/start/project-structure/
[tauri#8513]: https://github.com/tauri-apps/tauri/issues/8513

## Open

_No standing architectural decision is open here. Live open questions — the **X-ray panel
redesign** (the panel currently shows an inventory, not the per-project × harness *pre-flight*
the differentiator calls for), whether Hone ships a CLI, CI shape, PR-authoring, and
fleet/heartbeat scope — are tracked as the wayfinder map's frontier and fog ([#1]), the
index of record._

<!-- Resolved and moved to Settled / the map's Decisions-so-far: repo & app identifiers
     (#6), port strategy (#5), Claude Code AGENTS.md support (#3), Pi skill loading (#4),
     cloud auth (#10), repo layout (#8), frontend stack + toolchain (#7). Migration cutover
     (#11) is DISSOLVED — the command-center POC was never adopted, so there is no parity
     bar and no cutover checklist; Hone reimplements the ideas, it doesn't match a POC. -->

## Fog surfaced by [#8]

- **Does Hone ship a CLI, and what replaces `bootstrap.sh` on a fresh machine?** The
  `hone-core` split keeps a headless path *possible*; nothing decides whether it exists.
  If materializing skills requires launching a GUI, that's a product decision — it should
  be made deliberately, not inherited from a build file. No longer entangled with a parity
  bar: [#11] established there is no incumbent CLI to match, so this is a clean
  forward-looking choice.
- **The principle-2 CI guardrail** ("desktop builds green with `apps/cloud/` deleted") is
  agreed but unwired; it has no home until CI exists.
