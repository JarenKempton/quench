import { basename, win32 } from "node:path";
import { pathStyle } from "./files.ts";
import { scriptAccesses } from "./scripts.ts";

export type ShellReadBase = "absolute" | "home" | "cd" | "workdir" | "session folder";

export type ShellRead = {
  kind: "read" | "search" | "script-read" | "script-write" | "script-run";
  program: string;
  pattern: string | null;
  written: string;
  path: string | null;
  base: ShellReadBase | null;
};

type Word = { text: string; dynamic: boolean };
type Segment = { words: Word[]; inputs: Word[]; piped: boolean; heredoc: string | null };

const READERS: Record<string, string> = {
  cat: "",
  nl: "bdfhilnsvw",
  head: "nc",
  tail: "ncs",
  sed: "efl",
  bat: "lrHm",
  batcat: "lrHm",
  less: "",
  more: "",
};

const SEARCHERS: Record<string, { valued: string; recursive: boolean }> = {
  grep: { valued: "efmABCDd", recursive: false },
  egrep: { valued: "efmABCDd", recursive: false },
  fgrep: { valued: "efmABCDd", recursive: false },
  rg: { valued: "efgtTmABCMjEr", recursive: true },
  ag: { valued: "GgABCm", recursive: true },
  "git grep": { valued: "efmABCO", recursive: true },
};

const SEARCH_VALUED =
  /^--(regexp|file|max-count|context|after-context|before-context|include|exclude|exclude-dir|glob|iglob|type|type-not|replace|max-columns|threads|encoding|max-depth|ignore-file)$/;

const OPERATORS = ["&&", "||", ";;", "|&", "|", ";", "&", "\n", "(", ")"];

export function shellReads(
  command: string,
  places: { workdir: string | null; sessionFolder: string | null; home: string | null },
): ShellRead[] {
  const reads: ShellRead[] = [];
  let dir: { path: string; base: ShellReadBase } | null = places.workdir
    ? { path: places.workdir, base: "workdir" }
    : places.sessionFolder
      ? { path: places.sessionFolder, base: "session folder" }
      : null;
  for (const segment of segments(command)) {
    const start = segment.words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
    const words = start === -1 ? [] : segment.words.slice(start);
    const program = words[0] && !words[0].dynamic ? basename(words[0].text) : null;
    if (program === "cd") {
      const target = words[1];
      dir =
        !target || target.text === "~"
          ? places.home
            ? { path: places.home, base: "home" }
            : null
          : located(target, dir, places.home, "cd");
      continue;
    }
    const script = scriptAccesses(words, segment.heredoc);
    if (script) {
      for (const access of script.accesses) {
        const at = located(
          { text: access.written, dynamic: !access.literal },
          dir,
          places.home,
          null,
        );
        reads.push({
          kind: `script-${access.access}`,
          program: script.program,
          pattern: null,
          written: access.written,
          path: at?.path ?? null,
          base: at?.base ?? null,
        });
      }
      continue;
    }
    const search = program && searchOf(program, words, segment.piped, dir, places.home);
    if (search) {
      for (const word of search.paths) {
        const at = located(word, search.dir, places.home, null);
        reads.push({
          kind: "search",
          program: search.program,
          pattern: search.pattern,
          written: word.text,
          path: at?.path ?? null,
          base: at?.base ?? null,
        });
      }
      continue;
    }
    if (!program || !(program in READERS)) continue;
    for (const word of [...(operands(program, words.slice(1)) ?? []), ...segment.inputs]) {
      const at = located(word, dir, places.home, null);
      reads.push({
        kind: "read",
        program,
        pattern: null,
        written: word.text,
        path: at?.path ?? null,
        base: at?.base ?? null,
      });
    }
  }
  return reads;
}

const SETUP = new Set(["cd", "export", "source", ".", "set", "sleep", "true", "echo", "printf"]);

const FILTERS = new Set(["head", "tail", "sort", "uniq", "wc", "cut", "tr", "tee", "column", "jq"]);

export function commandSignature(command: string): string | null {
  const signatures = segments(command).flatMap((segment) => {
    const words = segment.words.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
    const program = words[0] && !words[0].dynamic ? basename(words[0].text) : null;
    if (program && (SETUP.has(program) || FILTERS.has(program))) return [];
    const sub = words.slice(1).find((w) => !w.text.startsWith("-"));
    return [
      program && sub && !sub.dynamic && /^[a-z][a-z0-9:_-]*$/.test(sub.text)
        ? `${program} ${sub.text}`
        : program,
    ];
  });
  return signatures.length === 1 ? signatures[0]! : null;
}

function searchOf(
  program: string,
  words: Word[],
  piped: boolean,
  dir: { path: string; base: ShellReadBase } | null,
  home: string | null,
) {
  let args = words.slice(1);
  if (program === "git") {
    let k = 0;
    while (args[k]?.text.startsWith("-")) {
      if (args[k]!.text === "-C") dir = located(args[k + 1] ?? args[k]!, dir, home, "cd");
      k += args[k]!.text === "-C" || args[k]!.text === "-c" ? 2 : 1;
    }
    if (args[k]?.text !== "grep") return null;
    args = args.slice(k + 1);
    program = "git grep";
  }
  const spec = SEARCHERS[program];
  if (!spec || args.some((a) => a.text === "--files")) return null;
  let pattern: string | null = null;
  let patternGiven = false;
  let recursive = spec.recursive;
  let options = true;
  const paths: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg.text === "--") {
      options = false;
      continue;
    }
    if (options && arg.text.startsWith("--")) {
      const [name, value] = arg.text.split(/=(.*)/s);
      if (/^--(recursive|dereference-recursive)$/.test(name!)) recursive = true;
      const taken = value ?? (SEARCH_VALUED.test(name!) ? args[++i]?.text : undefined);
      if (/^--(regexp|file)$/.test(name!)) {
        pattern ??= taken ?? null;
        patternGiven = true;
      }
      continue;
    }
    if (options && arg.text.startsWith("-") && arg.text.length > 1) {
      for (let j = 1; j < arg.text.length; j++) {
        const letter = arg.text[j]!;
        if (letter === "r" || letter === "R") recursive ||= !spec.valued.includes(letter);
        if (!spec.valued.includes(letter)) continue;
        const value = j < arg.text.length - 1 ? arg.text.slice(j + 1) : args[++i]?.text;
        if (letter === "e" || letter === "f") {
          pattern ??= value ?? null;
          patternGiven = true;
        }
        break;
      }
      continue;
    }
    if (!patternGiven) {
      pattern = arg.text;
      patternGiven = true;
    } else paths.push(arg);
  }
  if (!paths.length) {
    if (piped || !recursive) return null;
    paths.push({ text: ".", dynamic: false });
  }
  return { program, pattern, paths, dir };
}

function located(
  word: Word,
  dir: { path: string; base: ShellReadBase } | null,
  home: string | null,
  as: "cd" | null,
): { path: string; base: ShellReadBase } | null {
  if (word.dynamic || word.text === "-") return null;
  const style = pathStyle(word.text) === win32 ? win32 : pathStyle(dir?.path ?? home);
  if (style.isAbsolute(word.text))
    return {
      path: dir ? style.resolve(dir.path, word.text) : style.resolve(word.text),
      base: as ?? "absolute",
    };
  if (word.text === "~" || word.text.startsWith("~/"))
    return home
      ? { path: pathStyle(home).join(home, word.text.slice(1)), base: as ?? "home" }
      : null;
  if (word.text.startsWith("~") || !dir) return null;
  return { path: style.resolve(dir.path, word.text), base: as ?? dir.base };
}

function operands(program: string, args: Word[]): Word[] | null {
  const valued = READERS[program]!;
  const files: Word[] = [];
  let scriptGiven = false;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg.text === "--") {
      options = false;
      continue;
    }
    if (options && arg.text.startsWith("--")) {
      if (program === "sed" && arg.text.startsWith("--in-place")) return null;
      if (program === "sed" && /^--(expression|file)\b/.test(arg.text)) scriptGiven = true;
      if (
        !arg.text.includes("=") &&
        /^--(lines|bytes|expression|file|line-range|language)$/.test(arg.text)
      )
        i++;
      continue;
    }
    if (options && /^-[^\d]/.test(arg.text) && arg.text.length > 1) {
      for (let j = 1; j < arg.text.length; j++) {
        const letter = arg.text[j]!;
        if (program === "sed" && letter === "i") return null;
        if (!valued.includes(letter)) continue;
        if (program === "sed") scriptGiven = true;
        if (j === arg.text.length - 1) i++;
        break;
      }
      continue;
    }
    if (options && /^[-+]\d/.test(arg.text) && (program === "head" || program === "tail")) continue;
    if (program === "sed" && !scriptGiven) {
      scriptGiven = true;
      continue;
    }
    files.push(arg);
  }
  return files;
}

function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let segment: Segment = { words: [], inputs: [], piped: false, heredoc: null };
  let word: Word | null = null;
  let redirect: "in" | "out" | "string" | "heredoc" | null = null;
  const heredocs: { delimiter: string; owner: Segment }[] = [];
  const finishWord = () => {
    if (!word) return;
    if (redirect === "in") segment.inputs.push(word);
    else if (redirect === "heredoc") heredocs.push({ delimiter: word.text, owner: segment });
    else if (!redirect) segment.words.push(word);
    redirect = null;
    word = null;
  };
  const finishSegment = (piped = false) => {
    finishWord();
    if (segment.words.length || segment.inputs.length) out.push(segment);
    segment = { words: [], inputs: [], piped, heredoc: null };
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\n") finishWord();
    if (c === "\n" && heredocs.length) {
      finishSegment();
      i = readHeredocs(command, i + 1, heredocs.splice(0));
      continue;
    }
    if (!word && c === "#") {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      finishWord();
      i++;
      continue;
    }
    if (c === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      if (word && /^\d*$|^&$/.test((word as Word).text)) word = null;
      finishWord();
      const op = command.slice(i).match(/^(<<<|<<-?|<\(|>>|>&|>\||<>|>|<)/)![0];
      if (op === "<(") {
        i = skipBalanced(command, i + 1, "(", ")");
        word = { text: "<(…)", dynamic: true };
        continue;
      }
      redirect =
        op === "<" ? "in" : op === "<<<" ? "string" : op.startsWith("<<") ? "heredoc" : "out";
      i += op.length;
      continue;
    }
    const operator = OPERATORS.find((o) => command.startsWith(o, i));
    if (operator) {
      finishSegment(operator === "|" || operator === "|&");
      i += operator.length;
      continue;
    }
    word ??= { text: "", dynamic: false };
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word.text += command.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          word.text += '$`"\\\n'.includes(command[i + 1]!)
            ? command[i + 1]
            : command.slice(i, i + 2);
          i += 2;
        } else {
          if (command[i] === "$" || command[i] === "`") word.dynamic = true;
          word.text += command[i];
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      word.text += command[i + 1] ?? "";
      i += 2;
    } else if (c === "$" && command[i + 1] === "(") {
      word.dynamic = true;
      i = skipBalanced(command, i + 1, "(", ")");
      word.text += "$(…)";
    } else if (c === "`") {
      word.dynamic = true;
      const end = command.indexOf("`", i + 1);
      i = end === -1 ? command.length : end + 1;
      word.text += "`…`";
    } else {
      if ("$*?[{".includes(c)) word.dynamic = true;
      word.text += c;
      i++;
    }
  }
  finishSegment();
  return out;
}

function skipBalanced(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}

function readHeredocs(
  text: string,
  from: number,
  heredocs: { delimiter: string; owner: Segment }[],
): number {
  let i = from;
  for (const { delimiter, owner } of heredocs) {
    const start = i;
    let bodyEnd = text.length;
    while (i < text.length) {
      const end = text.indexOf("\n", i);
      const line = text.slice(i, end === -1 ? text.length : end);
      const lineStart = i;
      i = end === -1 ? text.length : end + 1;
      if (line.replace(/^\t+/, "") === delimiter) {
        bodyEnd = lineStart;
        break;
      }
    }
    owner.heredoc ??= text.slice(start, bodyEnd);
  }
  return i;
}
