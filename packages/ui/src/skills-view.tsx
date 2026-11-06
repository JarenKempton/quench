import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { CopyButton } from "./copy-button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.tsx";
import { cn } from "./lib/utils.ts";
import {
  correctionRate,
  flagsOf,
  HARNESS_LABELS,
  listing,
  skillFile,
  suggestion,
  type Flag,
  type Harness,
  type SkillRecord,
  type SkillsReport,
} from "./skills.ts";

type Row = { record: SkillRecord; flags: Flag[] };
type Key =
  | "skill"
  | "harness"
  | "origin"
  | "listed"
  | "used"
  | "byYou"
  | "listing"
  | "corrected"
  | "flags";

const ALL = "all";

const COLUMNS: { key: Key; label: string; numeric?: boolean }[] = [
  { key: "skill", label: "Skill" },
  { key: "harness", label: "Agent" },
  { key: "origin", label: "Origin" },
  { key: "listed", label: "Listed", numeric: true },
  { key: "used", label: "Used", numeric: true },
  { key: "byYou", label: "By you", numeric: true },
  { key: "listing", label: "Listing", numeric: true },
  { key: "corrected", label: "Corrected", numeric: true },
  { key: "flags", label: "Flags" },
];

const value = (row: Row, key: Key): string | number | null => {
  const r = row.record;
  switch (key) {
    case "skill":
      return r.skill;
    case "harness":
      return HARNESS_LABELS[r.harness];
    case "origin":
      return r.origin;
    case "listed":
      return r.use.sessionsListed;
    case "used":
      return r.use.used;
    case "byYou":
      return r.use.usedByUser;
    case "listing":
      return listing(r);
    case "corrected":
      return correctionRate(r);
    case "flags":
      return row.flags.length;
  }
};

const compare = (a: string | number | null, b: string | number | null) =>
  a === null
    ? b === null
      ? 0
      : 1
    : b === null
      ? -1
      : typeof a === "number"
        ? a - (b as number)
        : a.localeCompare(b as string);

const count = (n: number | null, lowerBound = false) =>
  n === null ? "–" : `${lowerBound && n ? "≥" : ""}${n.toLocaleString("en-US")}`;

const chars = (n: number | null) =>
  n === null ? "–" : n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;

export function SkillsView({
  report,
  agent = null,
}: {
  report: SkillsReport;
  agent?: Harness | null;
}) {
  const rows = useMemo(
    () => report.skills.map((record) => ({ record, flags: flagsOf(record, report) })),
    [report],
  );
  const harnesses = [...new Set(rows.map((r) => r.record.harness))];
  const origins = [...new Set(rows.map((r) => r.record.origin ?? "unknown"))].sort();
  const [harness, setHarness] = useState<string>(agent && harnesses.includes(agent) ? agent : ALL);
  const [origin, setOrigin] = useState(ALL);
  const [flagged, setFlagged] = useState(false);
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: "flags", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const shown = rows
    .filter(
      (r) =>
        (harness === ALL || r.record.harness === harness) &&
        (origin === ALL || (r.record.origin ?? "unknown") === origin) &&
        (!flagged || r.flags.length > 0),
    )
    .sort((a, b) => {
      const order = compare(value(a, sort.key), value(b, sort.key));
      const primary = sort.desc ? -order : order;
      return (
        primary ||
        compare(b.record.use.sessionsListed, a.record.use.sessionsListed) ||
        a.record.skill.localeCompare(b.record.skill)
      );
    });
  const flaggedCount = rows.filter((r) => r.flags.length).length;
  const toggleSort = (key: Key) =>
    setSort((s) =>
      s.key === key
        ? { key, desc: !s.desc }
        : { key, desc: COLUMNS.find((c) => c.key === key)!.numeric === true || key === "flags" },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Filter
          label="Agent"
          value={harness}
          onChange={setHarness}
          options={harnesses.map((h) => [h, HARNESS_LABELS[h]])}
        />
        <Filter
          label="Origin"
          value={origin}
          onChange={setOrigin}
          options={origins.map((o) => [o, o])}
        />
        <Filter
          label="Show"
          value={flagged ? "flagged" : ALL}
          onChange={(v) => setFlagged(v === "flagged")}
          options={[["flagged", `Flagged (${flaggedCount})`]]}
        />
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {shown.length} of {rows.length} skills
        </span>
      </div>
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6" />
              {COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(c.numeric && "text-right")}
                  aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className={cn(
                      "inline-flex items-center gap-1 hover:text-foreground",
                      sort.key === c.key && "text-foreground",
                    )}
                  >
                    {c.label}
                    {sort.key === c.key &&
                      (sort.desc ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ArrowUp className="size-3" />
                      ))}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => {
              const r = row.record;
              const isOpen = open === r.id;
              const rate = correctionRate(r);
              return (
                <Fragment key={r.id}>
                  <TableRow
                    data-state={isOpen ? "open" : "closed"}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setOpen(isOpen ? null : r.id)}
                  >
                    <TableCell className="pr-0 text-muted-foreground">
                      <ChevronRight
                        className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <button type="button" aria-expanded={isOpen} className="text-left">
                        {r.skill}
                      </button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {HARNESS_LABELS[r.harness]}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.origin ?? "unknown"}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {count(r.use.sessionsListed)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {count(r.use.used, r.use.lowerBound)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {count(r.use.usedByUser, r.use.lowerBound)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {chars(listing(r))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {rate === null ? "–" : `${Math.round(rate * 100)}%`}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.flags.map((f) => (
                          <Badge key={f.kind} variant="warn" title={f.reason}>
                            {f.label}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell />
                      <TableCell colSpan={COLUMNS.length}>
                        <Detail row={row} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        {!shown.length && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No skills match these filters.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Listed, used and by you count sessions. ≥ marks a lower bound: Codex loads skills through
        the shell. Corrected is the share of judged sessions that loaded the skill where a person
        corrected the agent: co-occurrence, not cause. Quench writes nothing; copy a prompt into
        your agent to make a change.
      </p>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => onChange(v || ALL)}
        aria-label={label}
      >
        <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
        {options.map(([v, text]) => (
          <ToggleGroupItem key={v} value={v}>
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function Detail({ row }: { row: Row }) {
  const r = row.record;
  const file = skillFile(r);
  const { prompt, note } = suggestion(r, row.flags);
  return (
    <div className="space-y-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
          {file ?? r.location}
        </code>
        {file && <CopyButton text={file} label="Copy path" />}
      </div>
      {row.flags.length ? (
        <ul className="space-y-1 text-sm">
          {row.flags.map((f) => (
            <li key={f.kind}>
              <span className="font-medium">{f.label}.</span>{" "}
              <span className="text-muted-foreground">{f.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing flagged for this skill.</p>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {prompt && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Prompt for your agent</span>
            <CopyButton text={prompt} label="Copy prompt" />
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  );
}
