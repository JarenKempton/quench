# Quench

Shows what coding agents load, what it costs, and where they go wrong, from the session history harnesses already keep. TypeScript on Bun. See `README.md` for commands and `docs/` for architecture and decisions. Direction: issue #45.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's **GitHub Issues** (`JarenKempton/quench`), operated via the `gh` CLI. The active direction is issue **#45** (the older `/wayfinder` map is #1). ⚠️ Prefix every `gh` call with `env -u GITHUB_TOKEN` in this environment (a stale token overrides auth). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. Canonical domain docs live in `docs/`; architectural decisions are recorded in `docs/decisions.md` (this repo's ADR-equivalent). See `docs/agents/domain.md`.
