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
- **Zero-setup discovery.** Projects come from the working directories sessions recorded,
  grouped by git repository, not from crawling the disk. Harness homes use their defaults
  and override variables, with a flag per harness when those fail.
- **Recorded loads over predictions.** When a session's history records the instructions it
  loaded, the profile reports that, and compares it with disk only by exact hash.
- **Worktree cleanup is report-only.** Quench lists idle worktrees and the command to remove
  each safe one; an opt-in purge with confirmation may follow once the list is trusted.
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
  normal reply classification, then groups person and automation corrections with separate typed
  decisions and a separate cache. Dry runs call neither judge and write neither cache; the grouping limit does
  not cap the preceding reply classification.
  It groups against bounded, deterministically ordered representative exchanges without a keyword
  taxonomy. Counts and source evidence are local; recurrence requires multiple native sessions.
  Quotations remain quotations, unclear stays ungrouped, and missing/failed sequential decisions
  block dependent work. No claim about ignored or unwritten rules is made without steering evidence.
- **Corrections are read behaviour-first.** A correction is a symptom, and the reply classifier
  was right only about half the time on real history. What the agent did comes from its log first:
  typed, model-free signals with evidence (repeated failures, invalid tool input, long or costly
  runs). A model is asked why only for replies already classified as corrections, never for every
  reply; there is no full re-judge. Signals the log cannot support (rework on the same files,
  claiming done too early) are left out rather than guessed from text.
  `corrections --causes` adds the one cause question as an opt-in section beside `--themes`, with
  its own judge id and cache. It is not a new command, because it reads the same classified
  replies and sender split.
- **Human correction and agent supervision are separate outcome signals.** Both can contribute
  to a corrective theme, with their own counts, sessions, recurrence and attributed examples.
  Unknown senders remain separate. Coordination is not automatically correction; agent-only
  evidence does not establish a human preference or justify a rule proposal by itself.
- **Steering inventory is current evidence, not historical attribution.** Adapters own native
  candidate locations; the offline scanner deduplicates exact bytes and preserves source
  paths, scopes and bullet/paragraph locations. Candidate presence does not prove effective
  loading. Precedence, conditions, imports and historical snapshots are not resolved, so no
  ignored-rule or never-written claim follows. Inventory never writes or calls a model.
- **Observed instructions come from what the harness recorded, not from today's files.**
  Per-file and combined coverage stay distinct, sessions without records are flagged rather than
  read as "none loaded", and missing evidence is never filled in from the current inventory.
- **Source tracing starts from recorded evidence.** Native read requests and results are
  normalized at the harness edge, then linked by unique call IDs and transcript order.
  Unsupported adapters and missing/ambiguous results remain explicit. Source filenames do not
  determine relevance, and current files never fill historical gaps. Returned tool text is
  fingerprinted without claiming complete delivery, continued retention or causal influence.
- **Run records may list tool names; analysis may not depend on them.** `runs --json` lists
  each call's recorded name, MCP server, outcome and result size as raw data. Patterns and
  rankings still use structural fields only, because hosts rename tools.
- **Releases run on two channels, nightly and stable.** Every merge to `main` replaces one
  rolling `nightly` pre-release; a maintainer cuts stable by choosing patch, minor or major.
  The version is stamped at build time, never committed. `quench update` downloads with `gh`.
- **The CLI comes first, then a local web page.** A desktop app comes later, if ever:
  monthly check-ins don't need a resident process.
- **Agents ask Quench through a skill that runs `quench … --json`**, not an MCP server,
  because MCP tool definitions are the largest source of context bloat Quench measures.
