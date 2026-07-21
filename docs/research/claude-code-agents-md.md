# Research: Does Claude Code natively read AGENTS.md?

**Ticket:** JarenKempton/quench#3
**Date researched:** 2026-07-16
**Verdict:** NO — Claude Code does not natively read `AGENTS.md`. It reads `CLAUDE.md` only. There is no automatic fallback to `AGENTS.md`.

## Answer

As of 2026-07, Anthropic's Claude Code CLI still loads project/user memory exclusively from `CLAUDE.md` (plus `CLAUDE.local.md` and `~/.claude/CLAUDE.md`). It does **not** read a repo-root `AGENTS.md` on its own, and it does **not** fall back to `AGENTS.md` when `CLAUDE.md` is absent.

- The official Claude Code changelog contains **no mention of `AGENTS.md`** in any released version (checked through v2.1.211, released 2026-07-15).
- Feature request [#6235 "Support AGENTS.md"](https://github.com/anthropics/claude-code/issues/6235) (opened 2025-08-21) remains **OPEN** with no official Anthropic implementation commitment and no linked PR/milestone. It is among the most-reacted open requests in the tracker (~5,200+ reactions).
- A related request, [#34235](https://github.com/anthropics/claude-code/issues/34235), asks for AGENTS.md as a native context file alongside CLAUDE.md — also unresolved.

## PARTIAL mechanisms (user-side, not native)

Support is only achievable by the operator, not by Claude Code out of the box:

1. **Import** — put `@AGENTS.md` inside `CLAUDE.md`. Claude Code's `@path` import syntax pulls the referenced file's contents into context. Requires a `CLAUDE.md` to exist.
2. **Symlink** — `ln -s AGENTS.md CLAUDE.md` so both names resolve to one file. Claude Code reads it because it is named `CLAUDE.md` on disk.

Both make AGENTS.md content reach Claude Code, but only via a `CLAUDE.md` entrypoint — the native reader never targets `AGENTS.md` itself.

## Contrast

Cursor, Windsurf, and Cline reportedly read a project-root `AGENTS.md` directly. Claude Code is the outlier that still requires the import/symlink bridge.

## Implication for Quench's x-ray

Do **not** treat `AGENTS.md` as a native Claude Code input. Treat it as an input **only if** the repo also has a `CLAUDE.md` that `@`-imports it, or a `CLAUDE.md -> AGENTS.md` symlink. Detect those two bridges explicitly rather than assuming AGENTS.md is read.

## Sources (dated)

- Claude Code changelog (no AGENTS.md entry, through v2.1.211, 2026-07-15): https://code.claude.com/docs/en/changelog
- GitHub issue #6235 "Support AGENTS.md" (OPEN, opened 2025-08-21): https://github.com/anthropics/claude-code/issues/6235
- GitHub issue #34235 "AGENTS.md as native context file" (open): https://github.com/anthropics/claude-code/issues/34235
