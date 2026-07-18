# Hone

*(working name — renameable until launch; see docs/naming.md)*

A desktop app that turns the chaos of AI agent configuration into order. See exactly
what enters each coding agent's context — skills, instruction files, MCP servers — per
project, per harness, per machine. Control it, version it, share it. You're the driver,
not the passenger.

**Not an orchestrator.** Hone never runs or commands agents. It governs what they're
equipped with.

## Principles

1. **No fake data.** Every number carries provenance: measured, configured (source
   shown), known spec, assumed (labeled), or honestly unknown.
2. **Local-first.** Fully functional with no account. Cloud adds sync/sharing, never
   becomes load-bearing.
3. **Align, don't fork.** SKILL.md per agentskills.io, AGENTS.md, marketplace.json,
   MCP registry. No invented formats; app data lives in `metadata:` or sidecars.
4. **Pinned and reviewed.** Skills pin by content hash; updates arrive as diffs you
   approve. Provenance ledger for everything. No "malware scanner" promises — pinning
   and review can't be evaded, scanners can.
5. **Hand-maintained wins.** The app helps you write and groom your own skills; the
   community registry is an install rail with review, not a firehose.

## Layout

- `docs/architecture.md` — three tiers, sources model, usage tracking, security layer
- `docs/mvp-scope.md` — what's in/out of v1, build phases
- `docs/decisions.md` — open decisions (wayfinder-style map)
- `docs/naming.md` — naming brief + kill list
- Prior art to port: `~/Documents/programming/agent-skills` (agentkit CLI + command
  center — the proven scanner/xray/apply/heartbeat logic this app absorbs)

## Stack

Tauri v2 (Rust core + webview), tray + window in one binary. Frontend is React 19 +
TypeScript + Vite + TanStack Router (hash history) + Zustand. Cloud (phase 3):
Cloudflare Workers + D1 + R2, GitHub OAuth.

## Repository layout

A pnpm + Cargo workspace (see hone#8):

- `crates/hone-core/` — pure Rust: scanner, git, provenance. No Tauri dependency, so a
  headless consumer stays possible and "cloud never load-bearing" is a boundary, not a
  discipline. The scaffold ships only a version probe — no real scanner yet.
- `apps/desktop/` — the Tauri app. React frontend at the top; `src-tauri/` **nested
  inside** it (the Tauri CLI resolves the frontend by walking *down* to the first
  `package.json`, so running from `apps/desktop/` needs no `TAURI_APP_PATH`).
- `apps/cloud/` — phase 3, not built yet. Desktop must build green with it deleted.
- `[profile.release]` lives at the **workspace root** — Cargo honors it only there;
  in `src-tauri/Cargo.toml` it would silently no-op.

## Running the scaffold

Prerequisites: Node ≥ 20, pnpm, and the Rust toolchain (`rustup`). On macOS the WebKit
webview ships with the OS; Linux needs `webkit2gtk`.

```sh
pnpm install          # from the repo root, once — installs the JS workspace

# then, either:
pnpm dev              # from the repo root — launches the desktop app (window + tray)

# or, equivalently, from the app directory:
cd apps/desktop
pnpm tauri dev
```

`pnpm dev` opens the **Hone** window and a tray icon (menu: Show / Quit) from one
binary, with the x-ray / matrix / skill-editor panels as stub shells. First run
compiles the Rust workspace, so give it a minute.

Other commands: `pnpm web` (frontend only, in a browser at `localhost:1420`),
`pnpm build` (bundle the desktop app), `cargo test -p hone-core`.
