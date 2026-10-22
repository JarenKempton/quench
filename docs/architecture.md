# Architecture

Quench is a TypeScript monorepo on Bun. Each package depends only on the packages above it.

```
packages/history    reads each harness's session files into one Session model
packages/insights   pure functions over sessions: runs, reports, signals
packages/judge      opt-in model judgments about runs, behind the Judge interface
packages/cli        the `quench` command; composition and formatting
```

## The Session model

A `Session` is an ordered list of typed events:

| Event                       | Fields                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `message`                   | `author` (user, assistant, injected), `origin` (typed, scheduled, host, unknown), `text`, optional `sender` evidence |
| `inference`                 | `model`, `effort`, `usage` (input, cacheRead, cacheWrite, output)                                                    |
| `tool_call` / `tool_result` | ids, name, `isError`, size of the result                                                                             |
| `compaction`                | trigger, tokens before                                                                                               |
| `instructions`              | injected instruction text recorded by the harness: path/directory, native label, SHA-256, length, unreadable count   |

Subagent sessions point at their parent with `parent`.

## Harness adapters

An adapter implements `Harness`: `discover(home)` lists session files, `read(ref)`
turns one into a `Session`, and `steering(home, project)` lists candidate instruction
locations. It is the only code that knows a harness's paths and file format. Rules every adapter follows:

- **Validate each line with zod.** Lines that don't fit are counted in
  `diagnostics.unparsed` and shown in the report, so a format change is visible instead
  of silently wrong.
- **Normalize at the edge.** `usage.input` never includes cached tokens, so context size
  means the same thing for every harness. Harness-added text (instruction files,
  environment blocks, command output) is `author: "injected"`.
- **Unknown stays unknown.** If a harness doesn't record something, the field is `null`.
  It never becomes zero.
- **Honor the harness's own override variable** for its data directory.

Adding a harness starts with one entry in `HarnessId`. The type checker then fails until
`harnessById` has an adapter for it, and that adapter must declare its id and label. Add
fixtures under `packages/history/test/fixtures/home`.

Adapters keep zod schemas because files on disk come from older harness versions and only a
runtime check catches format drift. Where a harness publishes types for its files, they are
dev dependencies and `test/vendor-types.test.ts` fails the type check if a schema reads a
field the vendor doesn't publish or with a different type: Pi (`@earendil-works/pi-coding-agent`)
fully, Claude Code's API message and content blocks (`@anthropic-ai/sdk`). The rest of the
Claude Code line and all of Codex are unpublished, so those fields are documented on the schema.

A new event kind breaks every `switch` that ends in `unhandled(event)` until it is handled.

## Current steering evidence

`steeringInventory` in history consumes adapter-supplied paths without branching on harness
names. It validates an explicit project directory, follows file/rule-directory symlinks with
cycle detection, bounds reads, and groups identical bytes by SHA-256. Every encountered source
retains its harness, path, canonical path and scope; content identity does not imply equal
scope or that a harness itself deduplicates the text. Stable IDs also match copied files in
separate worktrees without scanning those worktrees or persisting an index.

The report states `evidence: current-disk` and `historicalLoad: unknown`. It is an inventory
of candidates, not a resolution of native precedence, settings, imports or load conditions.
Rule candidates retain source line ranges for bullets/paragraphs, skipping headings,
frontmatter and fenced code. They are not semantic rules; source files remain authoritative
for conditions. Missing files are normal, unreadable sources and coverage limits warn.
There are no model calls, host/session reads or writes. Historical attribution remains a
separate future step; unmatched themes cannot be called unwritten preferences.

## Recorded source evidence

Each adapter declares whether it supports native file-read tracing. Claude Code normalizes
validated `Read` requests and structured text-file results into optional `fileRead` fields on
tool events. The recorded tool text is hashed and counted without retaining another content
copy. Pi normalizes native `read` requests and successful text-only outputs, leaving the result
path and line metadata null because its transcript does not supply them. Requested paths remain
verbatim; adapters do not reconstruct paths or line ranges from textual tool notices. Codex
explicitly reports unsupported coverage.

`sourceTrace` joins these normalized events by unique call IDs and transcript order, without
branching on tool names or harness names. Failed, missing, ambiguous and unsupported results
remain distinguishable. Returned metadata retains the path and reported range, not a claim of
full delivery, continued context retention or rule compliance. Shell/MCP sources are outside
this slice; current source files are never opened to fill historical gaps.

Adapters also declare how they record injected instructions: `per-file` (Claude Code
`instructions` and `nested_memory` attachments), `combined` (Codex `AGENTS.md instructions`
blocks, parsed per message part, with the directory but no file boundaries) or `unrecorded`
(Pi). The `instructions` event keeps only fingerprints and lengths, so it is observed historical
evidence that can later be compared with current steering inventory hashes. Insights ignore it.

## Optional host evidence

A host delivers messages to a harness; it is not another harness. The CLI may supply a
`SessionEnricher` between reading a session and deriving its runs. It adds generic
`SenderEvidence` (person/automation, source, message id), without rewriting transport origin,
message text, authors or run boundaries. Insights and judge never import host adapters.

`history/src/hosts/t3.ts` alone knows T3's SQLite projection format and native driver names.
The corrections command checks one known path or an explicit `--host-history` path, opens it
read-only in a consistent read transaction, and closes it after loading. It does not crawl the
filesystem or read the event log. Missing storage is a no-op; unreadable or incompatible storage
warns and falls back rather than discarding valid harness history.

T3 does not share a user-message id with the normalized transcript. Enrichment therefore
requires a strong native session link, unique exact text on both sides, and a harness timestamp
between host creation and 60 seconds later. Ambiguous links, repeated text, longer delivery
delays and unknown timestamps are left alone. Explicit agent authorship maps to automation;
only user/web or user/mobile records establish human authorship. Imported user/server records
remain unverified. This is deliberately incomplete, not a claim of universal sender identity.

## Insights

- A **run** is everything the agent did between two user messages: model, effort,
  context at start and peak, tool calls and errors, compactions, subagents, duration, and
  the reply that came next.
- A **report** totals runs and sessions per harness.

Insights never branch on harness and never look at tool or server names, because hosts
rename them.

## Judgments

`history` and `insights` never make a network call. Anything that needs a model goes through
`Judge` in `packages/judge`, which returns typed verdicts, never prose. `Jev` is the only judge
today; it uses `@typesafe-ai/sdk` with the user's key. `VerdictCache` stores each verdict keyed by
judge id plus the exact input, so changing a question (and its id) re-asks cleanly.

Who sent a reply comes from structure first: typed/scheduled harness origins, then optional
host sender evidence. Everything else is inferred by the judge from the message alone. The
output distinguishes harness evidence, host evidence, model inference and unresolved senders.
The cached verdict remains the model's answer; resolving the effective sender never overwrites
it, changes its key or re-asks it.

The corrections summary keeps person, automation and unresolved senders separate. Only classified
replies enter each attributed rate and signal set. Recent examples retain session/run locations
and sender evidence. Routine coordination remains its classified reply kind, not a correction.

### Correction themes

`corrections --themes` uses the normal reply pipeline: reuse cached verdicts, classify missing
replies with Jev, resolve senders, then select person and automation corrections for grouping.
Host evidence establishes authorship, not reply kind; classification remains necessary. Dry runs and no-key
replays open the verdict cache read-only, without compacting or writing it. Dry runs report
classification requests separately from grouping requests for already-known corrections; the
grouping limit does not bound classification. Failures in either stage produce a nonzero exit.
Session id, harness, source path and run position survive the reply boundary so evidence can count
distinct native sessions rather than folders or model calls. `Run.replyAt`
preserves the following user message's own timestamp without changing run boundaries or inferring
it from subsequent activity. Themes filters by this timestamp before limiting inputs; unknown
reply timestamps are excluded and reported separately.

`groupCorrections` in judge consumes generic replies and a separate typed `ThemeJudge`. It sorts
oldest-first with harness/session/run tie-breakers, consolidates exact exchanges while retaining
occurrences, and caps unique inputs at 20 by default (configurable up to 50). Each decision chooses
an existing exemplar, a new clear intent, or unclear. The same specific corrective intent is
required; vocabulary and setup names are not an algorithmic grouping signal. Only clipped exchange
text reaches Jev (assistant tail 500, correction head 1,000 Unicode code points), not source metadata.

`ThemeCache` is separate from reply verdicts, append-only for new validated decisions and read-only
on open. Its hash includes judge version and the exact question, choices, current excerpt and
ordered exemplars. Cache values include the returned classifier model, not derived aggregates.
Failures are not cached; one failed or missing assignment stops dependent work. A dry run replays
only the known prefix and reports later decisions as blocked, never hypothetical cache hits. The
Jev adapter disables retries and bounds requests to 10 seconds each and 60 seconds overall.

Evidence is aggregated locally, including separate person/automation counts and recurrence;
representative and example senders remain explicit. Agent-only groups do not establish human
preferences. Changing sender evidence recomputes counts without invalidating identical semantic
inputs in the cache. Other evidence includes distinct `(harness, sessionId)` sessions, last known
preceding-run models, missing-model counts, sender sources and source examples. Recurrence means
at least two distinct sessions; single-session groups remain in JSON. Labels are representative
quotations, not generated titles or rules. This is exploratory, order-dependent matching to one
exemplar, not all-pairs equivalence or evidence of what steering instructions were loaded. Native
session IDs are not independent occurrences: inherited conversation prefixes in forks are not
identified and may inflate evidence; both terminal and JSON expose this limitation.

## Reading at scale

`readSessions` streams one session at a time with a small concurrency limit, and each
adapter parses its file line by line. Memory stays flat no matter how much history there
is. On the reference machine, 3.6 GB across 1,220 files reads in about 8 s with a 0.5 GB
peak.
