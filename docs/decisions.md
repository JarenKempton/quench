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

[#9]: https://github.com/JarenKempton/hone/issues/9

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
