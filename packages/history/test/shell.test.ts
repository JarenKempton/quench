import { expect, test } from "bun:test";
import { shellReads } from "../src/shell.ts";

type Places = Parameters<typeof shellReads>[1];

const places: Places = { workdir: null, sessionFolder: "/repo", home: "/home/me" };
const paths = (command: string, where = places) =>
  shellReads(command, where)
    .filter((r) => r.kind === "read")
    .map((r) => [r.program, r.path, r.base]);

test("reads come from reader programs, options and their values skipped", () => {
  expect(
    paths(
      "sed -n '1,80p' src/a.ts && head -n 20 b.md | tail -5 && cat -n /etc/hosts ~/notes.md -- -c.md",
    ),
  ).toEqual([
    ["sed", "/repo/src/a.ts", "session folder"],
    ["head", "/repo/b.md", "session folder"],
    ["cat", "/etc/hosts", "absolute"],
    ["cat", "/home/me/notes.md", "home"],
    ["cat", "/repo/-c.md", "session folder"],
  ]);
});

test("writes, edits, searches and heredoc bodies are not reads", () => {
  expect(
    paths(
      [
        "cat > out.md <<'EOF'",
        "cat inside-heredoc.md",
        "EOF",
        "sed -i 's/a/b/' edited.ts",
        "rg -n needle searched.ts 2>/dev/null",
        "# cat commented.md",
        "cat < input.md 2>&1 > copy.md",
      ].join("\n"),
    ),
  ).toEqual([["cat", "/repo/input.md", "session folder"]]);
});

test("cd and the recorded workdir move relative paths; run-time paths stay unresolved", () => {
  expect(paths("cd /other && cat a.md; cd sub && cat b.md")).toEqual([
    ["cat", "/other/a.md", "cd"],
    ["cat", "/other/sub/b.md", "cd"],
  ]);
  expect(paths("cat a.md", { ...places, workdir: "/work" })).toEqual([
    ["cat", "/work/a.md", "workdir"],
  ]);
  expect(paths('cat "$FILE" docs/*.md $(git ls-files) && cd "$DIR" && cat c.md')).toEqual([
    ["cat", null, null],
    ["cat", null, null],
    ["cat", null, null],
    ["cat", null, null],
  ]);
  expect(paths("cat a.md", { workdir: null, sessionFolder: null, home: null })).toEqual([
    ["cat", null, null],
  ]);
});

test("searches are listed apart from reads, with the pattern and what was searched", () => {
  const searches = (command: string) =>
    shellReads(command, places).map((r) => [r.kind, r.program, r.pattern, r.path]);
  expect(
    searches(
      "grep -n -A 2 \"need\\|le\" src/a.ts lib && rg -g '*.ts' --type ts haystack && git -C /other grep -e x -- docs",
    ),
  ).toEqual([
    ["search", "grep", "need\\|le", "/repo/src/a.ts"],
    ["search", "grep", "need\\|le", "/repo/lib"],
    ["search", "rg", "haystack", "/repo"],
    ["search", "git grep", "x", "/other/docs"],
  ]);
  expect(
    searches("git log | grep fix; git log | rg fix; grep -r todo; grep plain; rg --files src"),
  ).toEqual([["search", "grep", "todo", "/repo"]]);
});
