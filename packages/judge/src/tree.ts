import { dlopen, FFIType } from "bun:ffi";

export type Child = Bun.Subprocess<Uint8Array, "pipe", "pipe">;
export type Tree = { proc: Child; kill(): void; release(): void };

type Options = { cwd: string; env: Record<string, string>; stdin: Uint8Array };

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

let kernel32: ReturnType<typeof load> | undefined;
const load = () =>
  dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;

export function spawnTree(argv: string[], options: Options): Tree {
  const windows = process.platform === "win32";
  const proc = Bun.spawn(argv, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
    detached: !windows,
  });
  return windows ? jobTree(proc) : groupTree(proc);
}

function groupTree(proc: Child): Tree {
  return {
    proc,
    kill: () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    },
    release: () => undefined,
  };
}

function jobTree(proc: Child): Tree {
  const k = (kernel32 ??= load());
  const job = k.CreateJobObjectW(null, null);
  const handle = k.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, proc.pid);
  const assigned = job !== null && handle !== null && k.AssignProcessToJobObject(job, handle) !== 0;
  if (handle !== null) k.CloseHandle(handle);
  if (!assigned) {
    proc.kill();
    if (job !== null) k.CloseHandle(job);
    throw new Error("could not put claude in a Windows job object");
  }
  return {
    proc,
    kill: () => {
      k.TerminateJobObject(job, 1);
      proc.kill();
    },
    release: () => {
      k.CloseHandle(job);
    },
  };
}
