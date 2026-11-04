import { pathParts } from "./files.ts";

export type Ecosystem = "npm" | "pypi" | "docker" | "git";

export type Launch = { runner: string; ecosystem: Ecosystem; spec: string };

type Runner = {
  ecosystem: Ecosystem;
  sub?: string;
  spec?: string[];
  valued: string[];
  flags?: string[];
};

const NPM_VALUED = ["--registry", "--cache", "--userconfig", "-c", "--call", "--node-options"];
const PY_VALUED = ["--with", "--python", "-p", "--index-url", "--index", "--directory", "--spec"];
const DOCKER_FLAGS = [
  "-i",
  "-t",
  "-d",
  "-P",
  "-it",
  "-ti",
  "--interactive",
  "--tty",
  "--detach",
  "--rm",
  "--init",
  "--privileged",
  "--read-only",
  "--publish-all",
  "--no-healthcheck",
  "--oom-kill-disable",
  "--sig-proxy",
  "--quiet",
  "-q",
];

const RUNNERS: Record<string, Runner> = {
  npx: { ecosystem: "npm", spec: ["-p", "--package"], valued: NPM_VALUED },
  pnpx: { ecosystem: "npm", valued: NPM_VALUED },
  bunx: { ecosystem: "npm", spec: ["-p", "--package"], valued: NPM_VALUED },
  npm: { ecosystem: "npm", sub: "exec", spec: ["-p", "--package"], valued: NPM_VALUED },
  pnpm: { ecosystem: "npm", sub: "dlx", valued: NPM_VALUED },
  yarn: { ecosystem: "npm", sub: "dlx", spec: ["-p", "--package"], valued: NPM_VALUED },
  bun: { ecosystem: "npm", sub: "x", spec: ["-p", "--package"], valued: NPM_VALUED },
  uvx: { ecosystem: "pypi", spec: ["--from"], valued: PY_VALUED },
  uv: { ecosystem: "pypi", sub: "tool", spec: ["--from"], valued: PY_VALUED },
  pipx: { ecosystem: "pypi", sub: "run", spec: ["--spec"], valued: PY_VALUED },
  docker: { ecosystem: "docker", sub: "run", valued: [], flags: DOCKER_FLAGS },
  podman: { ecosystem: "docker", sub: "run", valued: [], flags: DOCKER_FLAGS },
};

export function launchOf(command: string, args: readonly string[]): Launch | null {
  const runner = (pathParts(command).at(-1) ?? "").replace(/\.(cmd|exe|ps1)$/i, "").toLowerCase();
  if (runner === "cmd" && /^\/[ck]$/i.test(args[0] ?? "") && args[1]) {
    const inner = args.length === 2 ? args[1].trim().split(/\s+/) : args.slice(1);
    return launchOf(inner[0]!, inner.slice(1));
  }
  const known = RUNNERS[runner];
  if (!known) return null;
  let rest = [...args];
  if (known.sub) {
    if (rest[0] !== known.sub || (runner === "uv" && rest[1] !== "run")) return null;
    rest = rest.slice(runner === "uv" ? 2 : 1);
  }
  const spec = specOf(rest, known);
  if (!spec || /^(\.|\/|~|file:|[A-Za-z]:[\\/])/.test(spec)) return null;
  const clean = spec.replace(/:\/\/[^/@\s]+@/, "://");
  return { runner, ecosystem: gitSpec(clean, known.ecosystem) ?? known.ecosystem, spec: clean };
}

function specOf(args: string[], runner: Runner): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1] ?? null;
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (runner.spec?.includes(flag)) return inline ?? args[i + 1] ?? null;
    if (!arg.startsWith("-")) return arg;
    const valued = runner.flags ? !runner.flags.includes(flag) : runner.valued.includes(flag);
    if (inline === undefined && valued) i++;
  }
  return null;
}

function gitSpec(spec: string, ecosystem: Ecosystem): "git" | null {
  if (ecosystem === "docker") return null;
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(spec)) return "git";
  if (/^https?:\/\/\S+\.git(?:[#@]|$)/.test(spec)) return "git";
  return ecosystem === "npm" && /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec) ? "git" : null;
}
