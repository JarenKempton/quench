const KNOWN: Record<string, string> = {
  git: "status add commit push pull fetch clone checkout switch branch merge rebase reset restore diff log show stash tag remote worktree cherry-pick revert init config rm mv grep blame bisect submodule apply",
  gh: "pr issue repo run workflow api auth release gist search browse label secret status",
  bun: "run test install add remove build x update link pm create init",
  npm: "run test install ci add exec publish uninstall update init view ls start build pack audit",
  pnpm: "run test install add exec remove update build dlx",
  yarn: "run test install add remove build dlx",
  docker:
    "run build compose exec ps pull push images logs stop start rm rmi inspect network volume system",
  kubectl: "get describe apply delete logs exec create edit rollout port-forward config scale",
  cargo: "build run test check clippy fmt add install update publish bench doc",
  go: "build run test mod get install vet fmt generate env",
  uv: "run pip sync add remove lock venv tool python init",
  pip: "install uninstall list show freeze download",
};

const subcommands = new Map(
  Object.entries(KNOWN).map(([tool, names]) => [tool, new Set(names.split(" "))]),
);

const PROGRAMS = new Set([
  ...Object.keys(KNOWN),
  ..."bunx npx pip3 node deno python python3 pytest ruff tsc vp eslint prettier make cmake curl wget ssh scp rsync rg grep egrep sed awk cat ls find mkdir rm cp mv touch chmod chown ln tar unzip zip jq yq diff patch psql sqlite3 mysql redis-cli aws gcloud az terraform helm brew apt systemctl journalctl ps kill pkill pgrep lsof df du stat file which bash sh zsh pwsh powershell cmd".split(
    " ",
  ),
]);

export const knownProgram = (name: string): string => (PROGRAMS.has(name) ? name : "other command");

export function knownSubcommand(program: string, word: string | undefined): string | null {
  if (!word || !/^[a-z][a-z0-9-]{0,24}$/.test(word)) return null;
  return subcommands.get(program)?.has(word) ? word : null;
}

const TOOLS = new Set(
  "Bash BashOutput KillShell Read Write Edit MultiEdit NotebookEdit NotebookRead Glob Grep LS WebFetch WebSearch Task Agent TodoWrite Skill ExitPlanMode shell local_shell exec_command write_stdin apply_patch update_plan view_image bash read write edit grep find ls".split(
    " ",
  ),
);

export const knownTool = (name: string): string => (TOOLS.has(name) ? name : "other tool");
