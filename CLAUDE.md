# Hone

Cross-harness desktop app (Tauri v2) for visibility and control over everything entering AI coding agents' context. See `README.md` for the pitch and `docs/` for architecture, scope, decisions, and naming.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's **GitHub Issues** (`JarenKempton/hone`), operated via the `gh` CLI. The active `/wayfinder` map is issue **#1**. ⚠️ Prefix every `gh` call with `env -u GITHUB_TOKEN` in this environment (a stale token overrides auth). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. Canonical domain docs live in `docs/`; architectural decisions are recorded in `docs/decisions.md` (this repo's ADR-equivalent). See `docs/agents/domain.md`.
