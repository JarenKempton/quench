# Quench

See what your coding agents load, what it costs, and where they go wrong.

Quench reads the session history that Claude Code, Codex and Pi already keep on your
machine. It shows how much context each session starts with, how that grows, which models
and effort levels you use, and how each agent run went. Nothing leaves your machine
unless you opt in.

```
$ quench report        # on the test fixture home
Claude Code
  Sessions          1 (+1 subagent)
  Tokens processed  59.0k
  Starting load     median 21.0k  (p10 21.0k, p90 21.0k)  (85% of tokens processed)
  Compactions       1 in 1 sessions
  Effort            high 33%, medium 33%, unknown 33%
```

## Install

macOS and Linux (x64, arm64):

```sh
curl -fsSL https://quench.sh/install.sh | sh
```

Windows x64, in PowerShell 5.1 or later:

```powershell
irm https://quench.sh/install.ps1 | iex
```

Each script picks the binary for your machine from the latest stable release, checks it against
the release's `SHA256SUMS` and installs it to `~/.local/bin/quench` (Windows:
`%LOCALAPPDATA%\Programs\quench\quench.exe`), printing the line to add it to your `PATH` if it
isn't there. Set `QUENCH_RELEASE=nightly` or a tag such as `v0.2.0` for another release, and
`QUENCH_INSTALL_DIR` for another folder.

If a direct download is blocked, the scripts fall back to `gh release download` when the GitHub
CLI is signed in (`gh auth login`).

Or download a binary yourself and put it on your `PATH`:

```sh
curl -fsSL --create-dirs -o ~/.local/bin/quench https://github.com/JarenKempton/quench/releases/latest/download/quench-linux-x64
chmod +x ~/.local/bin/quench
quench --version
```

Swap in `linux-arm64`, `darwin-x64`, `darwin-arm64` or `windows-x64.exe`. `SHA256SUMS` in the
release lists each binary's checksum. The macOS binaries are not signed; a copy downloaded with
a browser needs `xattr -d com.apple.quarantine quench` before it runs.

Update in place with `quench update` (it uses the GitHub CLI, signed in with `gh auth login`).

| Channel | Published                                            | Switch with                       |
| ------- | ---------------------------------------------------- | --------------------------------- |
| stable  | Actions → Release → Run workflow (patch/minor/major) | `quench update --channel stable`  |
| nightly | On every merge to `main`, replacing the last one     | `quench update --channel nightly` |

Then run `quench setup`. It finds your agents' history (sessions and days per harness), prints the
summary, lets you pick a judge (tested on one made-up exchange, so none of your history is sent),
and would pair with a hub and open `quench ui` once those ship. Every step can be skipped; run it
again to resume where it stopped, or `quench setup judge` to redo one step. `quench setup --judge
none --yes` asks nothing and needs no key or hub. After that, `quench` with no arguments shows the
profile of every agent and project in your history.

## Commands

| Command                                         | What it shows                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `quench`                                        | A short summary: what sessions start with, what is worth a look, busiest projects                      |
| `quench setup [step] [--judge <name>] [--yes]`  | Find agents, show the summary, pick and test a judge; resumable, every step skippable                  |
| `quench profile [section]`                      | Every table, or one: `projects`, `mcp`, `instructions`, `skills`, `failures`                           |
| `quench worktrees [--days 30] [--json]`         | Idle linked worktrees, which are safe to remove and why the rest are kept; read-only                   |
| `quench report [--days 30] [--json]`            | Per harness: starting load, peak context, compactions, tool errors, models and effort                  |
| `quench runs [session-file \| --session <id>]`  | One session as prompt → what the agent did → your reply; default: latest one here                      |
| `quench runs --all --json [--history <dir>]`    | Every run of every session as JSON lines, per machine folder with `--history`                          |
| `quench corrections [--dry-run]`                | Human correction and agent supervision rates, counted separately. Opt-in, `--judge`                    |
| `quench corrections <file>... --session <id>`   | Corrections in those sessions only, with transcript line locators; `--json` is schema 1                |
| `quench steering <project-dir> [--json]`        | Instruction items ranked by recorded load, duplicates, conflicts, stale; offline                       |
| `quench sources [session-file] [--json]`        | What one session read and loaded; default: the latest session in this folder; offline                  |
| `quench secrets [--repo-history] [--json]`      | Exposed credentials, risky permissions, unpinned sources, git hooks; offline                           |
| `quench hub serve` / `quench hub import <repo>` | The fleet hub: skills in git, toggles, editor, pairing, bundles; first run needs `QUENCH_HUB_PASSWORD` |
| `quench connect <https://hub> --code … --pin …` | Pair this machine with a hub and fetch the bundle of skills assigned to it                             |
| `quench skill list\|show\|diff\|propose`        | Read this machine's assigned skills from the hub and propose a new `SKILL.md` for the owner to approve |
| `quench skills [--source <dir>] [--json]`       | One record per skill, agent and location: origin, use, tree hash, drift; read-only                     |
| `quench skills plan --source <dir>`             | What a skills checkout would change here, with `--machine <name> --json`; read-only                    |
| `quench skills apply --plan <hash>`             | Copies the planned skill folders; foreign or edited folders are left as conflicts                      |
| `quench skills status`                          | Conflicts, drift and install history from the ledger; exits 1 on conflicts or drift                    |
| `quench agent install\|uninstall\|run`          | A user service that keeps applying `--source` every `--interval`; never self-updates                   |

Agents find this through the shipped `quench` skill (the hub's "Add the shipped quench skill" button, then toggle it on like any skill). "Allow proposals" on a machine gives it a separate proposal token, revocable on its own, that can only read and propose changes to skills assigned to that machine. The owner approves each proposal on its review page by re-entering the password; a proposal whose skill changed since its base is stale and shows a 3-way diff instead.

The hub's data folder (`--data`, default `~/.quench/hub`) must be private to the user that runs it: the hub creates it 0700 and refuses to start if it is a link, owned by someone else, readable by group or others, or contains any symlink.

The hub also ships as a Docker image built from this repo (`docker build -t quench-hub .`); it
uses the image's system `git` for its internal skills repo and keeps everything under `/data`:

```sh
docker run --rm -v quench-hub:/data quench-hub import https://github.com/you/skills.git
docker run -d -p 8443:8443 -v quench-hub:/data -e QUENCH_HUB_PASSWORD=… quench-hub serve --url https://hub.lan:8443
```

`quench corrections` asks [Jev](https://typesafe.ai) what each reply to an agent run was doing, using
your own `TYPESAFE_API_KEY`. It sends the reply and the last 1,500 characters of the agent message
before it, and caches each answer in `~/.quench/local/judgments/`, one file per judge id, so a reply is paid for once.
`--dry-run` shows how many replies would be sent without sending anything.

Without a TypeSafe key, `--judge claude` classifies each reply through Claude Code, signed in as
you: one `claude -p` call to `claude-haiku-5-5` per reply, with the prompt on stdin. It sends the
same clipped text Jev receives, and `--dry-run --judge claude` counts the calls first. The output
names the judge that ran, and its verdicts are cached in their own file under their judge id, which
includes the model, so they never mix with or replace Jev's.

|              | Jev                                    | `--judge claude`                                           |
| ------------ | -------------------------------------- | ---------------------------------------------------------- |
| Cost         | Two small Jev requests per reply       | One Haiku call per reply on your Claude plan or key        |
| Speed        | 12 replies at a time                   | 4 replies at a time, seconds each                          |
| Data goes to | TypeSafe                               | Anthropic, under your account's data terms                 |
| Accuracy     | A fixed-choice classifier per question | A general model following a prompt; unmeasured against Jev |

Each call runs in an empty temporary folder with `--setting-sources ""`, so no user, project or
local settings, `CLAUDE.md`, rules, imports, skills or agents load. It also passes `--tools ""`,
`--strict-mcp-config` and `--disable-slash-commands`, turns hooks and auto-memory off, sets its own
system prompt, and uses `--no-session-persistence`, so nothing is added to your history. The child
gets only an allowlisted environment: path, home, temp, locale, Anthropic sign-in
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CONFIG_DIR`), proxy and CA variables, and the two telemetry opt-outs. Model overrides and
anything else in your shell never reach it. Claude Code adds its own note with the temporary
folder, platform and OS version. Bedrock, Vertex and settings that only live in `settings.json`,
such as `env` or `apiKeyHelper`, are not supported. A call that times out (its whole process group
is killed), exits non-zero or answers with anything but
the bare verdict counts as failed and is retried on the next run. After one non-zero exit, the
remaining replies are not attempted. On Windows, `--judge claude` refuses to run for now; use Jev there. Codex is not offered: `codex exec` cannot be run without
tools. `--themes` and `--causes` still use Jev.

`--judge openai` classifies through any OpenAI-compatible endpoint: one `POST /v1/chat/completions`
per reply with the same clipped prompt and a strict JSON schema. An answer that is not exactly a
verdict, a refusal, a `finish_reason` other than `stop`, a response over 1 MiB, or any HTTP error
counts as failed and is never guessed. Redirects are never followed and count as failed; after a
redirect, 401, 403 or 404 the rest are not attempted. The base
URL must be `https`, or plain `http` to a loopback or private address for a local model. A key a
header cannot carry is refused before any request, from the environment, the file or typed,
and keys are redacted from every error any judge reports. Its judge id names
the full base URL and the model as JSON (`openai/reply-v1/{"baseUrl":…,"model":…}`), so verdicts from different
endpoints or models never mix. `--judge none` makes no model calls: `corrections` says so and exits
2, and every other command works as before. An explicit `--judge` always wins over `QUENCH_JUDGE`.
A judge error, from Jev, `claude` or an OpenAI-compatible endpoint, names only the judge, one fixed
reason (auth, rate-limit, bad-request, server, timeout, too-large, refused or malformed) and the
HTTP status or exit code. Nothing a provider sent back, or `claude` printed, is ever shown.

`quench setup` saves the judge you pick, its base URL, model and any key you type (never echoed) in
`~/.quench/config.json`, created readable only by you (mode 0600). On Windows the file has no POSIX
mode and relies on your user profile folder's permissions. With no `--judge`, `corrections` uses
that choice, else Jev. Environment variables win over the file: `QUENCH_JUDGE`, `TYPESAFE_API_KEY`,
`QUENCH_OPENAI_BASE_URL`, `QUENCH_OPENAI_MODEL` and `QUENCH_OPENAI_API_KEY`. A key that came from
the environment is not written to the file.

Sender attribution uses harness metadata first, optional host evidence second, fixed message
formats third, and Jev's guess otherwise. Messages T3 Code records as its own notifications or
delegated-task results (`notification` / `delegatedCompletion`) count as host automation with kind
`info`. A notice that can't be joined to host history (delivered over 60 seconds after T3 created
it, repeated text, or not hosted) falls back to its fixed PR-watch, restart or delegated-task
text. A reply the harness recorded as a slash command
(Claude Code's `<command-name>`) counts as a person's `new_request` (harness source) unless
harness or host evidence says automation. Neither is sent to Jev. Text that merely starts with
`/` is not treated as a command: Codex and Pi record no command marker, so their replies are
judged normally. The output counts each source separately. Human and automation replies have separate
correction rates, outcome signals and recent examples; unresolved senders remain a separate
bucket. Rates use classified replies only; only the correction verdict increases their numerator.
JSON keeps human `signals` and `latest`, and adds `automationSignals`, `latestAutomation` and
`fromUnknown`. Examples show only the date, harness, session, run, verdict and sender evidence:
no reply text, folder or history path.

Each run also gets behaviour signals read from its own log, with no model call: the same failure
(kind, error class and the command's program and known subcommand, or the tool when no command was
recorded) 3 or more times, invalid tool input 2 or more times, 15 minutes or more of
agent time, and 10M or more tokens processed. They appear as yes/no rows in the "what came before"
tables, with the call positions behind them. Rework and
early "done" claims are not detected: edit targets and completion claims are not recorded
structurally, so detecting them would mean guessing from text.

`corrections` can read T3 Code's local
`~/.t3/userdata/statev2.sqlite` **read-only** when it exists; T3 is not another harness or a
requirement. Use `--host-history <sqlite-file>` for another location, or `--no-host-history` to
skip it. There is no recursive file search. Missing or incompatible host history leaves the
harness/model fallback intact; incompatible formats produce a warning.

T3 matching requires a strong native session link, unique exact message text in both histories,
and delivery within 60 seconds of host creation. Repeated, edited, delayed or otherwise
unmatched messages fall back to the judge. Imported `user/server` records are not proof of human
authorship. This uses T3's current internal format, not a stable public API. It does not change
cached judgments or send host records to Jev. `report` and `runs` do not read host history.

## Recurring correction themes

```sh
quench corrections --themes --dry-run --json
quench corrections --themes --theme-limit 20
```

`--themes` adds grouping to the normal corrections pipeline: reuse cached verdicts, classify
missing replies with Jev, resolve sender attribution, then group corrections from both people
and automation.
T3 evidence can establish who sent a reply, not whether it is a correction; Jev still determines
reply kind. Unresolved senders and failed or pending classifications remain excluded and visible
in the theme coverage. Automation corrections participate in the same bounded grouping process.

Grouping is a separate opt-in Jev choice question using `TYPESAFE_API_KEY`. Each exchange
is compared with earlier representative exchanges for the **same specific corrective intent**,
not just a shared topic. The output quotes a representative correction; it does not generate a
rule or infer which instructions existed. Counts, distinct sessions, preceding-run model labels,
sender-attribution sources and source examples are computed locally. Model-inferred people
remain labeled as such. Each theme separates `fromPeople` and `fromAutomation` correction counts,
session counts and recurrence, and labels the representative and example senders. Agent-only
themes are supervision evidence, not confirmed human preferences or proposed rules.
A group is labeled recurring only across at least two distinct sessions;
single-session groups remain available in JSON. A run's model is its last recorded model, not
necessarily every model used in that run.

The grouping default is the oldest **20 unique exchanges** in the selected period; `--theme-limit`
accepts 1–50. This limits grouping, not the preceding reply classification: each uncached reply
uses two classification requests, just as ordinary `corrections` does. Preview that workload
with `--dry-run` before a paid run; additional grouping work cannot be known until those replies
are classified. Exact duplicate exchanges share a grouping decision but retain their separate
evidence occurrences.
The window uses the correction message's own timestamp, not file modification or preceding-run
end time; corrections with unknown timestamps are excluded and counted separately. Coverage and
omitted counts are always shown. Each model-visible exchange is clipped to the
last 500 assistant characters and first 1,000 correction characters (Unicode code points),
including exemplars. Session paths, IDs, model labels and host records are not sent. At most one
request is made per selected unique exchange, with no retries, a 10-second per-request timeout
and a 60-second total grouping budget. `--examples` limits source examples, not analysis inputs.

Decisions have a separate cache at `~/.quench/local/themes.jsonl`, keyed by grouping version and
exact question, choices and ordered bounded exchanges. Counts are rebuilt from current evidence;
reply classifications retain their existing cache and grouping has its own. Fully cached results
need no key; without a key, missing work is reported with exit code 2. `--dry-run` makes no model
calls and writes neither cache. It reports pending classification requests and groups only known
corrections with attributed senders, replaying the cached grouping prefix before marking the
first missing decision pending and later inputs blocked. Their exemplar lists are not yet known. Failed assignments stop
the sequence without guessing later memberships; unclear assignments remain ungrouped. A failure
in either stage returns exit code 1, even if other known corrections can still be grouped.

These are exploratory, order-dependent representative matches—not proof that all group members
are equivalent, that a rule was ignored, or that the selected window covers every recurring issue.
Session counts are distinct native IDs, **not independent occurrences**: copied history in forks
can inflate both correction and session evidence. Inherited fork messages are not identified yet;
this limitation is also shown in terminal and JSON output.
Changing the window or earlier representatives can require new grouping decisions. Cached model
outputs are reproducible; the moving `jev-latest` alias is not an accuracy guarantee. No steering
files or histories are edited, no prose drafts are generated, and no live semantic-accuracy claim
is implied by local replay tests.

## What went wrong in corrections

```sh
quench corrections --causes --dry-run
quench corrections --causes --cached-only
quench corrections --causes --json
```

`--causes` asks Jev one fixed-choice question for each reply already classified as a correction,
never for other replies: what did the agent do wrong? The choices are misread instruction, wrong
assumption, ignored rule or instruction, bad tool use, rabbit hole / over-engineering, claimed
done too early, or none (steering or preference). Each answer sits beside the behaviour signals
from the run it reacted to. Totals are split by people, automation and unresolved senders, by
behaviour signal, and by the existing model, effort and harness buckets. Causes and behaviour are
correlations; neither proves the other.

Only the clipped exchange is sent, as with themes: the last 500 assistant characters and the
first 1,000 correction characters, with no paths, IDs or models. Identical exchanges share one
request. Answers are cached in `~/.quench/local/causes.jsonl`, keyed by the cause judge id plus
the exact question, choices and excerpt. `--dry-run` sends nothing, writes nothing and reports
the number of cause requests. Corrections not asked yet show as pending and failed answers as
failed. Neither is dropped or cached. Without a key, missing work exits with code 2, and a failure
exits with code 1. Each request has a 10-second timeout and no retries.

`--causes` first classifies any reply that has no cached verdict, which can cost far more than the
cause questions. `--cached-only` skips that step: replies without a verdict stay unclassified, and
only the corrections already known are asked about.

## What was in context when corrections recur

```sh
quench corrections --context --cached-only
quench corrections --context --cached-only --judge claude --json
```

`--context` groups corrections by the behaviour recorded in the run before each one, with no
model call. Groups use structural fields only: the behaviour kind (the same failure 3 or more
times, invalid tool input, a run of 15 minutes or more, 10M or more tokens) and the harness
tool name, never error or command text. Only corrections whose own timestamp falls inside
`--days` count. A group that spans 2 or more sessions is listed with its correction count
(people and agents apart), sessions and dates. It also lists every skill invoked and every
instruction and memory file loaded in those sessions, each with session and correction counts
and dates. A skill counts when the harness recorded an invocation or a successful read of its
listed file, not when a command merely names its path. Combined blocks, such as Codex's
`AGENTS.md instructions`, are listed per folder. Sessions with no record are counted, never
filled in from today's files. Evidence is the session id, run and date of the latest
corrections; no reply text is shown. It reads the verdict cache of the judge you pick, Jev's
or `--judge claude`'s, and with `--cached-only` asks neither. Being in context is a
correlation, not a cause. Nothing is edited.

## Profile

```sh
quench
quench profile failures
quench profile --days 90 --scan ~/code --json
```

`quench` with no arguments prints a one-screen summary: what every session starts with per
agent, where each agent's first request goes (system prompt, built-in tools, each MCP server's
tools, deferred tools, MCP instructions, instructions, skills) as rounded shares of the
characters it recorded sending, with any part a session did not record, a few things worth a
look (skills listed but never used, the failure that repeats most, a project whose
instructions dwarf the rest, idle worktrees), the busiest projects, and the command to dig
into each. `quench profile` prints every table below; `quench profile <section>`
prints one. `--json` is the same full result either way. Output is colored in a terminal and plain when piped,
with `NO_COLOR` set, or on a `dumb` terminal; `FORCE_COLOR=1` forces color.

The first run reads every session in the window, with a progress line; later runs reuse
per-session results kept in `~/.quench/local/session-places.json` (owner-only) and re-read only
session files whose size or modified time changed. The cache holds what the profile derives
per session (working folder, recorded instruction paths and sizes, skill names, MCP server
names, failure kinds with a short error summary, the first request split by source), not
transcripts. It resets when the Quench build changes. `--no-cache` reads everything and writes nothing.

Needs no arguments. It finds each harness home at its default location or override, reads
the sessions modified in the last `--days` (default 30) and takes each session's recorded
working directory as a project. Directories in one git repository, including linked
worktrees and subdirectories, group under its main checkout; others stand alone. Directories
no longer on disk are counted. Nothing else on the disk is searched: `--scan <dir>` adds that
repository, or the git repositories directly inside it, for projects with no sessions yet.

Each project shows the current steering inventory of its most recently used directory, with
user-level files listed once as global instructions. That is current-disk evidence, with the
same limits as `quench steering`; other worktrees may differ.

It also shows the instructions sessions recorded loading, as `quench sources` reads them:
the median per session for each project, and each recorded file with the sessions that
loaded it, its last recorded size and whether that text still matches the file on disk.
Copies of one file across worktrees fold into one row with a state per checkout. A match
is exact, allowing only the single final newline Claude Code drops. Text a harness
transformed (Claude Code stripping HTML comments) and Codex's combined per-directory
blocks are not comparable. Sessions from harness versions that recorded nothing count as
unknown, not zero.

Skills come from each agent's documented locations: user and project skill folders,
Claude Code's legacy commands and its fallback to the main checkout's skills in a
worktree, Codex's `~/.agents/skills` and bundled system skills, and Pi's nested skill
folders. The profile counts skills the model can see and their up-front name and
description size; bodies load on demand. MCP servers are read from each agent's config
files with scope and state (`on`, `off`, or `needs approval` for an unapproved
`.mcp.json` server). Only the server name, transport and command name or URL host are
shown; arguments, environment, headers and full URLs are never read out. Two servers of
one agent with the same URL or the same command and arguments are flagged as duplicates.
MCP tool definitions come from session history: per server, the tool count and schema size
the latest session recorded, and whether they load up front or are deferred to tool search
(deferred schemas are not starting load). A server no session recorded shows `not
recorded`. Built-in and plugin skills and plugin or managed MCP servers are not counted yet.

Recorded skills come from the skill lists histories logged: per agent, the sessions with a
listing, the median number of skills listed and listing size, which listed skills were
used and which were never used. A use is the model invoking a listed skill (Claude Code's
Skill tool), reading its file, or running a shell command or code that names its exact
listed path, which is how Codex loads skills, or the user running it as a command.
Relative paths are not resolved, so shell-based use is a lower bound.

MCP servers called come from the MCP tool calls sessions recorded, per agent, with
sessions and calls, and whether the agent's local config has a server of that name. Servers
missing from local config are account connectors (claude.ai, ChatGPT apps), plugins,
servers the host app passed in, or config since removed.

**Repeated failures** lists tool calls that failed the same way more than once, per project:
the same missing file, the same missing command, the same rejection by a hook or the agent,
the same bad tool input, or the same single command exiting nonzero. Each row shows how many
times it failed, in how many sessions, the longest streak in a row and the output it added
to context. Failures come from each harness's error flag. Codex has none, so its failures are
commands whose script printed a nonzero exit code, a lower bound. A search that found nothing
(`grep`, `rg`, `diff` exiting 1) is not a failure, and a chain of several commands that
fails is counted in the total but not attributed. The tokens of the turns around a failure
are not counted. The command makes no model calls and writes no files or caches.

## Idle worktrees

```sh
quench worktrees
```

For each git repository your sessions used, lists linked worktrees with no session in the last
`--days`. One is safe to remove when it is idle, not locked, has no uncommitted or untracked
changes, and its branch or commit is merged into the base branch (`origin/HEAD`, else `main` or
`master`) or its upstream branch was deleted. Each safe one comes with the exact
`git worktree remove` command; the rest show why they are kept, and folders already gone get
`git worktree prune`. `git worktree remove` keeps the branch but deletes ignored files such as
`.env`. Quench runs only read-only git commands and removes nothing.

## Exposed secrets

```sh
quench secrets
```

Finds credentials in the session history of Claude Code, Codex and Pi and in T3's local messages,
in harness and MCP configs, and in skills and instruction files. Each secret shows its provider,
the first 4 characters and a hash of its value, the sessions it appears in, the command or message
that exposed it, when it was first and last seen, and where to rotate it; a JWT names its `iss`
issuer and an HTTP auth header its host, and a secret with no known rotate link says so.
`.mcp.json` and `.env*` files with plaintext tokens are flagged when git tracks them. In `--json`
every finding has an id that stays the same across runs on this machine, and `locations` groups
each value by its tag across files, environment variable names and sessions. Risky permissions are bypass or full-access
defaults, wildcard shell allowlists and auto-approved MCP servers.

It also checks the files worms harvest (`~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.netrc`,
GitHub CLI, AWS, gcloud, Azure, kube and Docker credentials, unencrypted SSH keys, shell history,
agent logins and `.env*` files in your projects): present or absent, plaintext or not, file mode,
and whether a session read the file or printed one of its values. In the git repositories your
sessions used, it flags workflows that dump or send secrets and dependency install scripts that
run known worm payloads (Shai-Hulud, Nx s1ngularity) or are new, skipping known-benign scripts
matched by package name and script hash (esbuild's `postinstall`).

Rules that gitleaks limits to a file path, such as `hashicorp-tf-password` for `.tf` and `.hcl`,
only run on files with that path, never on session text.

Supply chain: it lists MCP servers, Claude Code marketplaces and plugins, and Pi packages whose
source is unpinned (`@latest`, no version, a range, or a branch instead of an exact version, tag or
commit), grouped by harness, with the pinned form to switch to. In the repositories your sessions
used, it lists executable git hooks (`.git/hooks` or `core.hooksPath`) and flags any not installed
by a known hook manager. `--repo-history` also scans every commit of those repositories for
secrets with the same rules, masks and tags; it is opt-in because it is slow on big repositories.
Ports, network and OS hardening, persistence and PATH are out of scope: use lynis, osquery or
trufflehog.

Detection uses the [gitleaks](https://github.com/gitleaks/gitleaks) ruleset (MIT, vendored in
`packages/secrets/vendor`) plus an entropy check. Everything runs locally: no secret, excerpt or
finding is sent to Jev, a model or the network. Nothing is changed or redacted.

## Current steering inventory

```sh
quench steering /path/to/project --json
```

Requires an explicit existing directory. The Claude Code, Codex and Pi adapters enumerate
built-in instruction filenames in their user locations and the directory's ancestor chain;
Codex stops at the nearest `.git` directory or worktree marker, or checks only the selected
directory outside a repository. Claude Code also scans ancestor/user `.claude/rules` trees.
Claude Code's auto memory `MEMORY.md` for the directory and its main checkout is included.
Harness directory environment overrides work just as they do for session discovery.
Candidate names follow [Claude Code's memory docs](https://code.claude.com/docs/en/memory),
[Codex's AGENTS.md docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and
Pi's installed `loadProjectContextFiles` implementation. Their effective-loading behavior
is deliberately not reproduced by this inventory.

The report merges byte-identical files by SHA-256 while retaining each harness, encountered
path, canonical path and user/ancestor/project scope. The same bytes have the same identity
across worktree paths; other worktrees are not searched. Rule candidates are original bullets
or paragraphs with line ranges, not semantic judgments. Headings, frontmatter and fenced code
are omitted; scope conditions remain in the source file and are not interpreted.

Items are ranked by characters × sessions loaded: for each session in this project in the last
`--days` (default 30), the characters its history recorded injecting each file. Codex records
combined blocks without file boundaries, so they are counted as coverage, not attributed. Below
the ranking come duplicate rules across files (same wording ignoring case, punctuation and list
markers), possible global-vs-project conflicts (the same action, one rule negated and one not)
and possibly stale entries (a backticked file not on disk, command not on `PATH`, or
package script missing from the file's nearest `package.json`), each citing every location. Conflicts and stale entries are
heuristics. `--rules` adds every bullet and paragraph with its line range.

**The inventory is current-disk evidence; only the ranking uses recorded loads.** Both ordinary
and override candidates remain visible: precedence, settings, imports, custom fallback names,
managed policy and runtime overrides are not resolved. Descendant instruction
files are not searched. No result establishes an ignored rule or a preference never written.
Unreadable/oversized sources, cycles and exhausted limits produce warnings. Reads are bounded
to 256 KiB per file, 256 files, 256 physical rule directories and 1,024 directory paths
(including symlink aliases). The command makes no model calls, reads session history (and the
session cache, if present) but no host history, and writes no files or caches, even when a key
is configured.

## Recorded session sources

```sh
quench sources
quench sources /path/to/discovered/session.jsonl --json
```

With no file, it picks the most recent session (any agent) whose working folder is the current
folder or inside it, and says which on stderr. Reads one session found in the configured harness
history directories. Claude Code's adapter
traces native `Read` calls when the transcript retains structured text-file results. Pi's adapter
traces native `read` requests and successful text-only results.
Any filename can appear, including README files, arbitrary documentation and skill references;
current copies of those source files are never opened. Codex has no native read tool, so its
native tracing is reported as unsupported; its reads show up as shell reads below.

Each attempt retains its call ID, request timestamp/path/offset/limit, result timestamp and
status: returned, failed, missing result or unknown. Returned evidence includes the recorded
path, reported line range and total lines when available, plus a SHA-256 of returned tool text
(including wrappers, not source-file bytes). Pi does not record result paths or reliable line
ranges; those fields stay unknown. Requested paths remain verbatim, without resolving them
against today's filesystem or assuming they identify local files. Text can include tool notices
instead of file content. Normalized events retain the fingerprint instead of the text.
Duplicate or out-of-order call/result IDs and malformed metadata remain uncertain. Parse gaps
and unmatched file results warn; other tool calls remain visible as an unattributed count.

**Shell reads** come from the commands each agent recorded running: Claude Code's and Pi's
shell tool, and Codex's `exec_command`, including several calls inside one code-mode script.
`cat`, `head`, `tail`, `sed` (not `sed -i`), `nl`, `bat`, `less`, `more` and `<` input count
as reads. Searches (`grep`, `rg`, `ag`, `git grep`) are listed separately as searches, with
the pattern and the files or folders searched; a search returns matching lines, not the file,
so it is never counted as a read. A search of piped input is not a file search.
Inline Python, JavaScript and Ruby (`python3 - <<EOF`, `-c`, `node -e`) is scanned for file
opens such as `open(p, 'w')`, `Path(x).read_text()` or `readFileSync(x)`, when the path is
written out or held in a variable set once. These are listed as script reads or writes,
never as reads, because a script only shows the agent a file it prints. Script files run
(`python3 scripts/x.py`, `uv run`, `npx tsx`) are listed by name; what they open isn't
known. Remote `ssh` commands are not parsed. Each read keeps
the program, the path as written and the resolved path. It also records what the path was
resolved from: absolute, home, a `cd` earlier in the same command, Codex's recorded working
folder, or the session folder. Paths built from variables, globs or substitutions stay
unresolved, and commands not recorded as literal text are counted. Status says whether the
command ran, failed or has no result. Output size covers the whole command, not one file.

The same report lists **instructions the harness recorded injecting** into context, with their
timestamp, path, native label (for example Claude Code's `User`, `Project`, `Local`, `AutoMem`)
and a SHA-256 of the recorded text. Claude Code records each file at session start and each
subdirectory file loaded on demand; it flags text it processed before injecting (for example
stripped HTML comments), so those hashes won't match the file's bytes. Pi records each context
file in its system-prompt `project_context` section. Codex records one combined
`AGENTS.md instructions` block per directory, without file boundaries, so its path stays
unknown. Instructions re-injected after a compaction, or inherited by a forked session, are
listed at that point. A session with none gets a warning, since older harness versions didn't
record them. Malformed entries are counted and warned. Recorded instructions show what was in
context, not that a rule was followed.

It also lists **MCP calls** by server and tool, with whether a result came back and its size.
Arguments are never read out, so which page, document or record a call fetched is not shown.
Calls inside a Codex code-mode script share that script's result.

This is partial session evidence. Automatic imports, skill loading, images and unchanged-file references are not reconstructed. A recorded text
result does not prove the model used or obeyed it, retained it after compaction, or received
the complete file. Reported ranges are metadata, not a completeness guarantee. The command
makes no model calls, reads no host database and writes no files or caches.

## Status

Early and changing. Direction and scope: [#45](https://github.com/JarenKempton/quench/issues/45).
Releases are built by `.github/workflows/release.yml`; see [Install](#install) for the channels.

## Run from source

Needs [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bunx vp run quench report
bunx vp run compile   # a single binary at dist/quench
```

Checks: `bunx vp check` and `bunx vp run test`. Tasks live in `vite.config.ts`; `vp test` (Vitest on Node) does not apply here because the readers use Bun APIs.

## Supported harnesses

| Harness                               | Reads from             | Override                               |
| ------------------------------------- | ---------------------- | -------------------------------------- |
| Claude Code (CLI, desktop, Agent SDK) | `~/.claude/projects`   | `CLAUDE_CONFIG_DIR` or `--claude-home` |
| Codex (CLI, app)                      | `~/.codex/sessions`    | `CODEX_HOME` or `--codex-home`         |
| Pi                                    | `~/.pi/agent/sessions` | `PI_CODING_AGENT_DIR` or `--pi-home`   |

Adding one is a single file in `packages/history/src/harnesses/`. See
[docs/architecture.md](docs/architecture.md).

## License

MIT
