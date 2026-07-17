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
- Port strategy (hone#5): **Rust-native from day one** — no bundled Python (the
  command_center POC retires at parity, hone#11). Git ops **shell out to the system
  `git` binary** (proven POC invocations; not git2/gitoxide). UI boundary is **Tauri
  `invoke` commands** — POC JSON contract kept as serde structs, HTTP transport dropped
  (no open port). Incremental: scaffold ports only the scanner.

## Open

- [ ] Repo/app identifiers while name is provisional (bundle id, binary name) — pick
      neutral-ish or commit to hone?
- [ ] Per-project manifest format + location (`.hone/manifest.json`? `.agents/`?) —
      must not collide with existing conventions
- [ ] Claude Code native AGENTS.md support status (contested as of 2026-07) — verify
      against changelog before building the dedupe view
- [ ] Pi skill-loading behavior (index vs full-body) — verify before showing token costs
- [ ] Cloud auth: GitHub OAuth only vs + magic-link email at launch of phase 3
- [ ] Migration: agent-skills repo becomes first source; command center retires when
      app reaches parity — define the cutover checklist
