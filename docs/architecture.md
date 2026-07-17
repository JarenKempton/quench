# Architecture

## Three tiers

1. **Local app** (Tauri): scanner (find harnesses + skills incl. project strays),
   context x-ray, skill/instruction editors, matrix (skill × harness × machine ×
   project) with staged apply, local git backing. Rust core watches filesystems;
   webview reuses the command-center UI patterns.
2. **Cloud service** (optional, phase 3): Cloudflare Workers + D1 + R2. Accounts
   (GitHub OAuth, magic-link later), machines, circles (work/friends), skill publishing,
   usage-event ingestion. Content-addressed skill versions server-side; the local app
   always materializes into local git, so users own their data if the service dies.
3. **Distribution**: machines pull desired state, push telemetry. Per-project manifest
   (`~/.hone/projects/<key>.json` — machine-local, never in the project repo; see
   decisions.md) materialized into `.claude/skills`/agents dirs (Ephemeral pattern:
   derived, excluded via `.git/info/exclude`, ownership inferred from symlink targets).

## Sources model (version control)

Every skill belongs to a **source**; every source is git:
- external repo (pinned by SHA, read-only, diff-on-update)
- own repo (e.g. existing agent-skills catalog)
- circle repo (shared org)
- app-managed (`~/.hone/local.git`, invisible git for non-git users; syncs via cloud
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

Claude Code (~/.claude/skills, CLAUDE.md, hooks), Codex (AGENTS.md only — no skill
loader; render an index), Pi (git packages, loads skills/ wholesale), Hermes
(~/.hermes/skills + profiles). Context-window table per model with source
(config-override | model-spec | assumed-labeled).
