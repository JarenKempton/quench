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
- **Model judgments go through one `Judge` interface** ([#45](https://github.com/JarenKempton/quench/issues/45)).
  `history` and `insights` stay offline. Jev is the first judge, through TypeSafe's own SDK,
  opt-in via `TYPESAFE_API_KEY`. Verdicts are cached per judge id and input, so a reply is paid
  for once. The cache format is the Rust prototype's, so its verdicts carry over.
- **One adapter per harness, structure over names.** See
  [architecture.md](architecture.md).
- **Hosts enrich history; they do not redefine harnesses.** Optional local host adapters add
  generic sender evidence before run derivation. Host SQL, paths and native driver names stay
  outside harness readers, insights and judge. Uncertain matches abstain; unavailable sources
  fall back visibly. Harness evidence wins over host evidence, which wins over model inference.
  Cached model verdicts and their questions stay unchanged.
- **Themes compare corrective intent; they do not draft rules.** The opt-in themes mode extends
  normal reply classification, then groups person corrections with separate typed decisions and
  a separate cache. Dry runs call neither judge and write neither cache; the grouping limit does
  not cap the preceding reply classification.
  It groups against bounded, deterministically ordered representative exchanges without a keyword
  taxonomy. Counts and source evidence are local; recurrence requires multiple native sessions.
  Quotations remain quotations, unclear stays ungrouped, and missing/failed sequential decisions
  block dependent work. No claim about ignored or unwritten rules is made without steering evidence.
- **Steering inventory is current evidence, not historical attribution.** Adapters own native
  candidate locations; the offline scanner deduplicates exact bytes and preserves source
  paths, scopes and bullet/paragraph locations. Candidate presence does not prove effective
  loading. Precedence, conditions, imports and historical snapshots are not resolved, so no
  ignored-rule or never-written claim follows. Inventory never writes or calls a model.
- **Source tracing starts from recorded evidence.** Native read requests and results are
  normalized at the harness edge, then linked by unique call IDs and transcript order.
  Unsupported adapters and missing/ambiguous results remain explicit. Source filenames do not
  determine relevance, and current files never fill historical gaps. Returned tool text is
  fingerprinted without claiming complete delivery, continued retention or causal influence.
- **The CLI comes first, then a local web page.** A desktop app comes later, if ever:
  monthly check-ins don't need a resident process.
- **Agents ask Quench through a skill that runs `quench … --json`**, not an MCP server,
  because MCP tool definitions are the largest source of context bloat Quench measures.
