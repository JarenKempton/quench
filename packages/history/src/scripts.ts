import { basename } from "node:path";

export type ScriptAccess = { access: "read" | "write" | "run"; written: string; literal: boolean };

type Language = "python" | "js" | "ruby" | "perl";

const LANGUAGES: [RegExp, Language][] = [
  [/^python(\d+(\.\d+)?)?$/, "python"],
  [/^(node|bun|deno|tsx|ts-node)$/, "js"],
  [/^ruby$/, "ruby"],
  [/^perl$/, "perl"],
];

const CODE_FLAGS: Record<Language, string[]> = {
  python: ["-c"],
  js: ["-e", "--eval", "-p", "--print"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
};

const VALUED: Record<Language, string[]> = {
  python: ["-W", "-X"],
  js: ["-r", "--require", "--import", "--loader"],
  ruby: ["-I", "-r"],
  perl: ["-I", "-M"],
};

const SCRIPT = /\.(py|m?js|cjs|m?ts|rb|pl)$/;

const CALLS: Record<Language, [RegExp, "read" | "write" | "mode"][]> = {
  python: [
    [/(?<![.\w])open\(/g, "mode"],
    [/\.(?:read_text|read_bytes)\(/g, "read"],
    [/\.(?:write_text|write_bytes)\(/g, "write"],
    [/\.open\(/g, "mode"],
  ],
  js: [
    [/\b(?:readFileSync|readFile|createReadStream)\(/g, "read"],
    [/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\(/g, "write"],
    [/\bBun\.file\(/g, "read"],
    [/\bBun\.write\(/g, "write"],
  ],
  ruby: [
    [/\bFile\.(?:read|readlines|foreach)\(/g, "read"],
    [/\bFile\.write\(/g, "write"],
    [/\bFile\.open\(/g, "mode"],
  ],
  perl: [],
};

export function scriptAccesses(
  words: { text: string; dynamic: boolean }[],
  heredoc: string | null,
): { program: string; accesses: ScriptAccess[] } | null {
  const texts = words.map((w) => w.text);
  while (["uv", "poetry", "pipenv"].includes(texts[0]!) && texts[1] === "run") texts.splice(0, 2);
  while (["npx", "bunx"].includes(texts[0]!)) texts.splice(0, 1);
  if (texts[0] === "pnpm" && texts[1] === "exec") texts.splice(0, 2);
  const program = texts[0] ? basename(texts[0]) : "";
  const language = LANGUAGES.find(([pattern]) => pattern.test(program))?.[1];
  if (!language) return null;
  if ((program === "bun" || program === "deno") && texts[1] === "run") texts.splice(1, 1);
  let code: string | null = null;
  for (let i = 1; i < texts.length; i++) {
    const arg = texts[i]!;
    if (CODE_FLAGS[language].includes(arg)) {
      code = texts[i + 1] ?? null;
      break;
    }
    if (language === "python" && arg === "-m") return { program, accesses: [] };
    if (arg === "-") {
      code = heredoc;
      break;
    }
    if (VALUED[language].includes(arg)) i++;
    if (arg.startsWith("-")) continue;
    return {
      program,
      accesses: SCRIPT.test(arg)
        ? [{ access: "run", written: arg, literal: !dynamic(words, arg) }]
        : [],
    };
  }
  code ??= heredoc;
  return { program, accesses: code ? codeAccesses(code, language) : [] };
}

const dynamic = (words: { text: string; dynamic: boolean }[], text: string) =>
  words.find((w) => w.text === text)?.dynamic ?? false;

function codeAccesses(code: string, language: Language): ScriptAccess[] {
  const assignments = literals(code, language);
  const seen = new Map<string, ScriptAccess>();
  for (const [pattern, access] of CALLS[language])
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length;
      const args = callArgs(code, open);
      const method = match[0].startsWith(".");
      const target = method ? receiverOf(code, match.index) : args[0];
      if (!target) continue;
      const mode =
        access !== "mode"
          ? access
          : /^r?["'][^"']*[wax]/.test(modeOf(args, method ? 0 : 1) ?? "")
            ? "write"
            : "read";
      const path = pathOf(target, (name) => {
        const last = assignments.findLast((a) => a.name === name && a.index < match.index);
        return last?.value ?? undefined;
      });
      const key = `${mode}\0${path.written}`;
      if (!seen.has(key)) seen.set(key, { access: mode, ...path });
    }
  return [...seen.values()];
}

function modeOf(args: string[], position: number): string | null {
  return (
    args.find((a) => /^mode\s*=/.test(a))?.replace(/^mode\s*=\s*/, "") ?? args[position] ?? null
  );
}

function receiverOf(code: string, end: number): string | null {
  const before = code.slice(0, end);
  const call = before.match(/(Path\((?:[^()]|\([^()]*\))*\))$/);
  if (call) return call[1]!;
  return before.match(/([A-Za-z_]\w*)$/)?.[1] ?? null;
}

function pathOf(
  expression: string,
  lookup: (name: string) => string | undefined,
): { written: string; literal: boolean } {
  const text = expression.trim();
  const wrapped = text.match(/^Path\(\s*(.*?)\s*\)$/s);
  if (wrapped) return pathOf(wrapped[1]!, lookup);
  const literal = text.match(/^r?(["'`])([^"'`]*)\1$/);
  if (literal && !(literal[1] === "`" && literal[2]!.includes("${")))
    return { written: literal[2]!, literal: true };
  const known = /^[A-Za-z_$][\w$]*$/.test(text) ? lookup(text) : undefined;
  if (known !== undefined) return { written: known, literal: true };
  return { written: text.length > 60 ? `${text.slice(0, 59)}…` : text, literal: false };
}

function literals(code: string, language: Language) {
  const assignment =
    language === "js"
      ? /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g
      : /(?:^|;)[ \t]*([A-Za-z_]\w*)\s*=(?!=)\s*([^;\n]+)/gm;
  return [...code.matchAll(assignment)].map((m) => {
    const path = pathOf(m[2]!, () => undefined);
    return { name: m[1]!, index: m.index, value: path.literal ? path.written : null };
  });
}

function callArgs(code: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = from;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        args.push(code.slice(start, i).trim());
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args.filter(Boolean);
}
