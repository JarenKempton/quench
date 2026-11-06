import { useCallback, useEffect, useState } from "react";
import { CopyButton } from "./copy-button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import {
  freshness,
  plan,
  rotations,
  type FileSecrets,
  type HistorySecret,
  type SecretsReport,
  type WorktreesReport,
} from "./housekeeping.ts";
import { viewerShell } from "./skills.ts";

type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: T; computedAt: string | null; refreshing: boolean };

function useReport<T>(path: string) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      setState({
        status: "ready",
        report: (await response.json()) as T,
        computedAt: response.headers.get("x-quench-computed-at"),
        refreshing: response.headers.get("x-quench-refreshing") === "true",
      });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return [state, load] as const;
}

export function HousekeepingView() {
  const [worktrees, reloadWorktrees] = useReport<WorktreesReport>("/api/worktrees");
  const [secrets, reloadSecrets] = useReport<SecretsReport>("/api/secrets");
  return (
    <div className="space-y-10">
      <Section title="Idle worktrees" state={worktrees} retry={reloadWorktrees}>
        {(report) => <Worktrees report={report} />}
      </Section>
      <Section title="Exposed secrets" state={secrets} retry={reloadSecrets}>
        {(report) => <Secrets report={report} />}
      </Section>
    </div>
  );
}

function Section<T>({
  title,
  state,
  retry,
  children,
}: {
  title: string;
  state: Load<T>;
  retry: () => void;
  children: (report: T) => React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {state.status === "ready" && state.computedAt && (
          <span className="flex items-baseline gap-2 font-mono text-xs text-muted-foreground">
            {freshness(state.computedAt, state.refreshing, Date.now())}
            <Button variant="outline" size="sm" onClick={retry}>
              Reload
            </Button>
          </span>
        )}
      </div>
      {state.status === "loading" && (
        <Note>
          Reading your session history… The first scan can take minutes; later visits show the last
          result at once.
        </Note>
      )}
      {state.status === "error" && (
        <Note>
          <span className="font-mono text-xs">{state.message}</span>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        </Note>
      )}
      {state.status === "ready" && children(state.report)}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-6 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function Worktrees({ report }: { report: WorktreesReport }) {
  const shell = viewerShell();
  const plans = report.repositories.map((repo) => plan(repo, shell));
  const removable = plans.flatMap((p) => p.removable);
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {count(removable.length)} safe to remove across {count(plans.length)}{" "}
        {plans.length === 1 ? "repository" : "repositories"} · idle means no session in the last{" "}
        {report.days} days · Quench removes nothing
      </p>
      {!plans.length && <Note>No linked worktrees in the repositories your sessions used.</Note>}
      {removable.length > 1 && (
        <Command
          text={removable.map((r) => r.command).join("\n")}
          label={`Copy all ${count(removable.length)}`}
        />
      )}
      {plans.map((p) => (
        <div key={p.root} className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <code className="font-mono text-xs break-all">{p.root}</code>
            <span className="font-mono text-xs text-muted-foreground">
              {count(p.active)} active · {count(p.removable.length)} safe · {count(p.kept.length)}{" "}
              kept · base {p.base ?? "unknown"}
            </span>
          </div>
          {p.removable.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Safe to remove</h3>
              {p.removable.map(({ worktree, command }) => (
                <div key={worktree.path} className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {worktree.branch ?? "detached"}
                    {worktree.upstreamGone && " · upstream deleted"}
                    {worktree.merged && " · merged"}
                  </span>
                  <Command text={command} label="Copy" />
                </div>
              ))}
            </div>
          )}
          {p.kept.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Idle but kept</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worktree</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Why it stays</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.kept.map((w) => (
                    <TableRow key={w.path}>
                      <TableCell className="font-mono text-xs break-all">{w.path}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {w.branch ?? "detached"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {w.reasons.map((reason) => (
                            <Badge key={reason} variant="outline">
                              {reason}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {p.prune && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Folders already gone</h3>
              <Command text={p.prune} label="Copy" />
            </div>
          )}
        </div>
      ))}
      <Limitations items={report.limitations} />
    </div>
  );
}

function Secrets({ report }: { report: SecretsReport }) {
  const { history } = report;
  const credentials = report.credentialFiles.filter((f) => f.present && f.values.length);
  const files = [...report.configs, ...report.instructions.files];
  const rotate = rotations(report);
  const repo = report.repoHistory;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {count(history.secrets.length)} in {count(history.sessions)} sessions ·{" "}
        {count(files.length)} config and instruction files · values show their first 4 characters
        and a keyed tag, never in full
      </p>
      <Block title="Session history">
        {history.secrets.length ? (
          <HistoryTable found={history.secrets} />
        ) : (
          <Empty>No high-confidence secrets in session history.</Empty>
        )}
      </Block>
      {history.lowConfidence.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {count(history.lowConfidence.length)} lower-confidence values (generic rule or
          secret-named value) are left out here; run quench secrets to see them.
        </p>
      )}
      <Block title="Files with plaintext secrets">
        {files.length || credentials.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Values</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <FileRow key={f.path} file={f} />
              ))}
              {credentials.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-mono text-xs break-all">{f.path}</TableCell>
                  <TableCell className="text-muted-foreground">{f.label}</TableCell>
                  <TableCell>
                    <Masked found={f.values} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {f.tracked && <Badge variant="warn">tracked by git</Badge>}
                      {f.othersCanRead && <Badge variant="warn">others can read</Badge>}
                      {f.printedInSessions && <Badge variant="warn">printed by an agent</Badge>}
                      {f.readInSessions > 0 && (
                        <Badge variant="outline">read in {count(f.readInSessions)} sessions</Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>No plaintext secrets in harness configs, instructions or credential files.</Empty>
        )}
      </Block>
      {repo && (
        <Block title="Repo git history">
          {repo.secrets.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>Files</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repo.secrets.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{s.masked}</TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {s.repos.join(", ")}
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {s.files.join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>No high-confidence secrets in repo history.</Empty>
          )}
        </Block>
      )}
      {rotate.length > 0 && (
        <Block title="Where to rotate">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Issued by</TableHead>
                <TableHead>Rotate at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rotate.map((r) => (
                <TableRow key={`${r.provider}\n${r.issuer ?? ""}`}>
                  <TableCell>{r.provider}</TableCell>
                  <TableCell className="text-muted-foreground">{r.issuer ?? ""}</TableCell>
                  <TableCell className="font-mono text-xs break-all">
                    {r.rotate ?? "no rotate link known, rotate it where it was issued"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Block>
      )}
      <p className="text-xs text-muted-foreground">
        Permissions, unpinned servers, worm footprints and git hooks are in quench secrets.
      </p>
      <Limitations items={[...report.limitations, ...report.warnings]} />
    </div>
  );
}

function HistoryTable({ found }: { found: HistorySecret[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>Exposed by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {found.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{s.provider}</TableCell>
            <TableCell className="font-mono text-xs">{s.masked}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
              {count(s.sessions)}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {s.lastSeen?.slice(0, 10) ?? "unknown"}
            </TableCell>
            <TableCell className="text-muted-foreground">{s.exposures[0]?.by ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FileRow({ file }: { file: FileSecrets }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs break-all">{file.path}</TableCell>
      <TableCell className="text-muted-foreground">
        {[...new Set(file.secrets.map((s) => s.provider))].join(", ")}
      </TableCell>
      <TableCell>
        <Masked found={file.secrets} />
      </TableCell>
      <TableCell>{file.tracked && <Badge variant="warn">tracked by git</Badge>}</TableCell>
    </TableRow>
  );
}

function Masked({ found }: { found: { id: string; masked: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {found.map((s) => (
        <code key={s.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {s.masked}
        </code>
      ))}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="rounded-lg border border-border">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Limitations({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

const count = (n: number) => n.toLocaleString("en-US");
