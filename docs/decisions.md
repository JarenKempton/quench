# Decisions

The current direction is [#45](https://github.com/JarenKempton/quench/issues/45): a
profiler and steering coach for coding agents. Decisions from the earlier skill-manager
direction (git-backed skill sources, per-skill pins, a cloud tier, a Tauri tray app) were
retired with it and live in git history.

## Product

- **Name: Quench** ([#30](https://github.com/JarenKempton/quench/issues/30)).
- **Not an orchestrator.** Quench reads what agents did and helps you steer them. It
  never runs agents.
- **Local-first.** Everything works offline from files already on the machine. Anything
  that sends data anywhere is opt-in and says what it sends.
- **No fake numbers.** Every number traces to a file on disk, and estimates are labeled.
- **Align, don't fork.** Quench writes harness-native settings and never invents a format.
- **Users bring their own compute.** Model-backed analysis uses the user's own key, so
  running Quench costs its maintainers nothing per user.

## Engineering

- **TypeScript on Bun** ([#45](https://github.com/JarenKempton/quench/issues/45)). It is
  readable by the maintainer and the agent-tool community. Bun supplies the test runner,
  file I/O, SQLite and single-binary builds. A Rust prototype (closed PRs #36–#47) proved
  the model first. If scanning is ever measured to be too slow, only `readSessions` would
  move to a native addon.
- **Few dependencies.** `zod` for validating harness formats, plus Bun's built-ins.
  Vite+ for lint, format and type checks. Anything new needs a reason a built-in can't
  cover.
- **One adapter per harness, structure over names.** See
  [architecture.md](architecture.md).
- **The CLI comes first, then a local web page.** A desktop app comes later, if ever:
  monthly check-ins don't need a resident process.
- **Agents ask Quench through a skill that runs `quench … --json`**, not an MCP server,
  because MCP tool definitions are the largest source of context bloat Quench measures.
