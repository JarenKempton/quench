export type Shell = "posix" | "powershell";

const SAFE: Record<Shell, RegExp> = {
  posix: /^[\w%+=:./][\w@%+=:./-]*$/,
  powershell: /^[\w%+=:./\\][\w@%+=:./\\-]*$/,
};

export function quoteArg(value: string, shell: Shell, always = false): string {
  if (!always && SAFE[shell].test(value)) return value;
  return shell === "posix"
    ? `'${value.replaceAll("'", `'\\''`)}'`
    : `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`;
}
