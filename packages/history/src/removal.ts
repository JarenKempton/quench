export type Shell = "posix" | "powershell";

export const shellFor = (platform: string = process.platform): Shell =>
  platform === "win32" ? "powershell" : "posix";

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

export const removeLink = (path: string, shell: Shell) =>
  shell === "posix"
    ? `rm -- ${quoteArg(path, shell)}`
    : `(Get-Item -LiteralPath ${quoteArg(path, shell)}).Delete()`;

export function withEnv(variable: string, value: string | null, command: string, shell: Shell) {
  if (value === null) return command;
  return shell === "posix"
    ? `${variable}=${quoteArg(value, shell)} ${command}`
    : `$env:${variable}=${quoteArg(value, shell, true)}; ${command}`;
}
