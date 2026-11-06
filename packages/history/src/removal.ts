import { quoteArg, type Shell } from "./quote.ts";

export { quoteArg, type Shell };

export const shellFor = (platform: string = process.platform): Shell =>
  platform === "win32" ? "powershell" : "posix";

export function withEnv(variable: string, value: string | null, command: string, shell: Shell) {
  if (value === null) return command;
  return shell === "posix"
    ? `${variable}=${quoteArg(value, shell)} ${command}`
    : `$env:${variable}=${quoteArg(value, shell, true)}; ${command}`;
}
