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

export function knownSubcommand(program: string, word: string | undefined): string | null {
  if (!word || !/^[a-z][a-z0-9-]{0,24}$/.test(word)) return null;
  return subcommands.get(program)?.has(word) ? word : null;
}
