# Quench

Cross-harness desktop app (Tauri v2 and GPUI frontends over one Rust core) for visibility and control over everything entering AI coding agents' context. See `README.md` for the pitch and `docs/` for architecture, scope, decisions, and naming.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's **GitHub Issues** (`JarenKempton/quench`), operated via the `gh` CLI. The active `/wayfinder` map is issue **#1**. If a stale `GITHUB_TOKEN` in your shell overrides `gh` auth, prefix calls with `env -u GITHUB_TOKEN`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. Canonical domain docs live in `docs/`; architectural decisions are recorded in `docs/decisions.md` (this repo's ADR-equivalent). See `docs/agents/domain.md`.
