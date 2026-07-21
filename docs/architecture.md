# Architecture

## Three tiers

1. **Local app** (Tauri): scanner (find harnesses + skills incl. project strays),
   context x-ray, skill/instruction editors, matrix (skill × harness × machine ×
   project) with staged apply, local git backing. Rust core watches filesystems;
   webview reuses the command-center UI patterns.
2. **Cloud service** (optional, phase 3): Cloudflare Workers + D1 + R2. Accounts via
   **Better Auth (GitHub + Google, auto-link on verified email)** — sign-in is split from
   the GitHub *grant* for repo features; magic-link is **not** planned (#10). Better Auth
   runs on Workers + D1, version-pinned (#14). Machines, circles (work/friends), skill
   publishing, usage-event ingestion. Content-addressed skill versions server-side; the
   local app always materializes into local git, so users own their data if the service dies.
3. **Distribution**: machines pull desired state, push telemetry. Per-project manifest
   splits by owner — committed `./.quench/manifest.json` (what's *available*: sources +
   menu; a PR to change) and personal `~/.quench/projects/<key>.json` (what *you* activate,
   at what tree SHA). Source skills materialize into `.claude/skills`/agents dirs
   (Ephemeral pattern: copied at their pinned tree, excluded via `.git/info/exclude`,
   ownership recorded in the manifest). Skills committed to the project sit in the same
   dirs, tracked by the project's own git. See decisions.md.

## Sources model (version control)

Every skill belongs to a **source**; every source is git:
- external repo (pinned by SHA, read-only, diff-on-update)
- own repo (e.g. existing agent-skills catalog)
- circle repo (shared org)
- app-managed (`~/.quench/local.git`, invisible git for non-git users; syncs via cloud
  when an account exists)

Skill instance = (source, path, pinned content hash). History/rollback/diff = git.
Provenance ledger records where everything came from, who added it, when it changed.

## Usage tracking

- Session-log scanning: Claude Code exact (Skill tool_use events with ts/cwd), Pi/Codex
  best-effort. Proven in agentkit.
- Harness hooks where supported (Claude Code hooks) for real-time events.
- NOT filesystem read-listening — reads aren't observable without kernel-level
  instrumentation (eBPF/Endpoint Security). Don't pretend otherwise.
- With cloud: events aggregate → per-skill, per-user, per-machine usage; stale-age/rot.

## Security layer

Pin-by-hash · diff-on-update with approval · provenance ledger · `allowed-tools`
surfaced · lint (hidden chars, encoded blobs, whole-tree incl. scripts/ and
references/) · team allowlist mode (emit marketplace.json + settings so harnesses
enforce natively). Context: Snyk found 36% of community skills flawed; scanners are
bypassable (Trail of Bits) — hence pinning+review, not scanning promises.

## Harness adapters

Claude Code (~/.claude/skills, CLAUDE.md, hooks), Codex (AGENTS.md **plus skills** —
`[[skills.config]]` in `~/.codex/config.toml`; the old "no skill loader, render an index"
note is refuted), Pi (git packages, loads skills/ **by index** — frontmatter → XML
`<available_skills>`, bodies lazily; the old "wholesale" note is refuted), Hermes
(~/.hermes/skills + profiles). Context-window table per model with source
(config-override | model-spec | assumed-labeled).

**Per-user deselect is not uniform** and Quench must degrade honestly: Claude Code is clean
(`skillOverrides` in the auto-gitignored `.claude/settings.local.json`); Codex is
global-only (`~/.codex/config.toml`) and its project-local skill filtering is broken
(codex#20210); Pi's project `.pi/settings.json` is *committed* with no gitignored local
layer; Hermes has no per-skill toggle at all.
