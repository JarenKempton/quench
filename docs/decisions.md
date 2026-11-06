# Decisions

The current direction is [#45](https://github.com/JarenKempton/quench/issues/45): a
profiler and steering coach for coding agents. Decisions from the earlier skill-manager
direction (git-backed skill sources, per-skill pins, a cloud tier, a Tauri tray app) were
retired with it and live in git history.

## Product

- **Name: Quench** ([#30](https://github.com/JarenKempton/quench/issues/30)).
- **Not an orchestrator.** Quench reads what agents did and helps you steer them. It
  runs agents only for evals the owner starts, in scratch homes with tools, hooks, plugins and
  MCP off, so replays never reach real history ([#137](https://github.com/JarenKempton/quench/issues/137), amending the earlier "never runs agents").
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
- **Secrets are detect-and-report only** ([#111](https://github.com/JarenKempton/quench/issues/111)).
  Detection is local with the gitleaks ruleset, values are masked, and redaction is a later opt-in.
- **Quench writes only user-declared skill files** ([#137](https://github.com/JarenKempton/quench/issues/137)).
  The fleet writes whole skill folders, byte-for-byte as declared, into harness-native skill
  folders it owns, journaled in a ledger and reversible. Folders it did not write, or that changed
  since, are conflicts and stay untouched. It never writes model output, harness config,
  instructions or hooks. Claude Code, Codex and Pi discover skill folders natively, so no config
  edit is needed.
- **Agent-written skill content is a proposal until the owner approves it** ([#137](https://github.com/JarenKempton/quench/issues/137)).
  A proposal names its base tree hash and an immutable revision; the proposing machine comes from
  its token and agent, harness and session fields are labelled claims. Only owner approval makes
  it user-declared content the fleet may write.
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
- **`quench ui` is the one exception: React, Tailwind, Radix and shadcn/ui, build-only**
  ([#134](https://github.com/JarenKempton/quench/issues/134)). The data is live and local, so
  every view renders in the browser from `/api/skills`, and shadcn is built for React and Vite.
  Vite (already in the toolchain through Vite+) builds `packages/ui` to fixed-name static files
  that `bun build --compile` embeds; none of these packages ships as runtime code outside that
  page. The server binds 127.0.0.1, checks the Host header, and sends a strict CSP.
- **Model judgments go through one `Judge` interface** ([#45](https://github.com/JarenKempton/quench/issues/45)).
  `history` and `insights` stay offline. Jev is the first judge, through TypeSafe's own SDK,
  opt-in via `TYPESAFE_API_KEY`. Verdicts are cached per judge id and input, one file per judge id, so a reply is paid
  for once. The cache format is the Rust prototype's, so its verdicts carry over.
- **Judges are pluggable providers** ([#140](https://github.com/JarenKempton/quench/issues/140)).
  Jev, the user's own `claude`, any OpenAI-compatible endpoint, or none, all behind `Judge`. They
  share one set of reply questions outside any provider. Each provider's id names its model (and
  endpoint host for OpenAI-compatible ones), every judge-derived number names that id, and rates
  never mix judges. Themes and causes stay Jev-only until another provider passes their fixtures.
  `none` turns off model calls only. The choice and any typed key live in a 0600 config file that
  environment variables override.
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
- **Steering ranks by recorded loads, and its findings are labelled heuristics** ([#104](https://github.com/JarenKempton/quench/issues/104)).
  An item's cost is the characters sessions recorded injecting it, never size × an assumed
  session count. Duplicates, conflicts and stale names cite every location; the flat rule list
  needs `--rules`.
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
- **Commands and corrections render from a fixed vocabulary, never history text** ([#128](https://github.com/JarenKempton/quench/issues/128)).
  `runs --json` commands and failures name an allowlisted program, a known subcommand and an
  error class; correction examples name only date, harness, session, run, verdict and sender.
  Masking free text was shown unsafe in #126, so it is removed instead.
- **`runs --all` folds a prompt sent mid-turn into the run as `steering`; corrections still split per prompt.**
  A message sent before the agent answered the one before it is judged as a follow-up reply to
  the run the agent last answered, never dropped ([#154](https://github.com/JarenKempton/quench/issues/154)).
- **Releases run on two channels, nightly and stable.** Every merge to `main` replaces one
  rolling `nightly` pre-release; a maintainer cuts stable by choosing patch, minor or major.
  The version is stamped at build time, never committed. `quench update` downloads with `gh`.
- **Linux, macOS and Windows are all supported and tested** ([#118](https://github.com/JarenKempton/quench/issues/118)).
  CI runs the full check and test suite on Ubuntu, macOS (arm64) and Windows, and a release
  publishes only after the darwin binary runs a real command on a macOS runner.
- **Fleet contracts live in `packages/fleet`** ([#137](https://github.com/JarenKempton/quench/issues/137)).
  zod schemas for the fleet file, bundle manifest, ledger, plan, snapshot and proposal, frozen
  before the hub, agent and UI are built. A skill version is its tree hash: SHA-256 over
  `<mode> <path>\0<sha256 of bytes>\n` per file, sorted by UTF-8 bytes. Paths use `/`, must
  already be NFC, must not fold together by case or Unicode, and must be valid on Windows (no
  reserved device names, trailing dots or spaces, or `<>:"|?*`); anything else is rejected, never
  normalised. Hash mode is
  `120000` for a symlink, hashed by the raw bytes of its target and not followed, else `100644`.
  The executable bit is not hashed, because Windows cannot read it; it travels as the bundle
  file's mode and the ledger's executables, and is compared wherever the OS can read it. The skill folder itself is followed; `.git`, `.DS_Store` and `Thumbs.db` are
  excluded. Plans are deterministic: no timestamps, `~/` paths, the same bytes on every OS.
  A skill's scope is deny-by-default: it reaches a machine only when the fleet opens that scope
  or the machine accepts it, and a denied skill is named in the plan with its reason.
  A skill source must resolve inside the source repo, and any unreadable or unparseable fleet
  file, registry, manifest or override fails the plan; only an absent file counts as empty.
  The importer follows no links in its input (`registry.yaml`, the fleet file, `hosts/` and its
  overrides): each path is checked with `lstat` first, and a symlink, dangling or not, or anything
  other than a regular file or folder fails the plan without being opened.
  Ledger operations are ordered by their sequence number, never by `appliedAt`, which is
  information only, so a clock rollback cannot change ownership.
- **The hub keeps desired state in git and nothing else** ([#139](https://github.com/JarenKempton/quench/issues/139)).
  Skills and the fleet file live only in the hub's internal git repo; SQLite holds credential
  hashes and reported state, never assignments. Every change is a compare-and-swap commit on
  HEAD, and rollback is a revert commit. Machines hold no repo credentials: they receive only the
  files of their own assigned skills, keyed by hash, and their identity comes from their token.
  A self-signed hub is trusted by SPKI pin; verification is never turned off for requests, and
  plain HTTP is loopback only.
- **The agent keeps the last good bundle when the hub is unreachable** ([#157](https://github.com/JarenKempton/quench/issues/157)).
  Without `--source`, `quench agent run` follows the paired hub: it applies a bundle only after every
  file matches its hash and every skill folder its tree hash, so a failed or partial fetch never
  becomes an empty bundle and never removes anything. The first snapshot after missed or failed polls
  carries `staleSince`; the hub shows that window until the next snapshot clears it. Before every git
  subprocess the hub re-checks that `GIT_DIR` is a plain folder inside its data folder.
- **The CLI comes first, then a local web page.** A desktop app comes later, if ever:
  monthly check-ins don't need a resident process.
- **Agents ask Quench through a skill that runs `quench … --json`**, not an MCP server,
  because MCP tool definitions are the largest source of context bloat Quench measures.
