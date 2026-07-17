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
- **Per-project state: Hone writes nothing into the project repo**
  ([#9](https://github.com/JarenKempton/hone/issues/9)) — desired
  state lives at `~/.hone/projects/<key>.json` (JSON, Hone-written, never hand-edited,
  pointers only). `.claude/skills/` is derived and excluded via `.git/info/exclude`,
  never `.gitignore`. Skills live in a **separate git repo** and are never committed
  into the consuming project: committed skills have no upstream to pin or diff against,
  so "pinned and reviewed" becomes theater and updates break teammates by default.
  Ownership of materialized links is inferred from symlink targets, never recorded —
  observed state can't drift. Amends the `./.hone/` bucket in the identifiers decision.

## Open

- [ ] Repo/app identifiers while name is provisional (bundle id, binary name) — pick
      neutral-ish or commit to hone?
- [ ] Port strategy: shell out to Python agentkit from Rust vs incremental Rust rewrite
- [ ] Claude Code native AGENTS.md support status (contested as of 2026-07) — verify
      against changelog before building the dedupe view
- [ ] Pi skill-loading behavior (index vs full-body) — verify before showing token costs
- [ ] Cloud auth: GitHub OAuth only vs + magic-link email at launch of phase 3
- [ ] Migration: agent-skills repo becomes first source; command center retires when
      app reaches parity — define the cutover checklist
