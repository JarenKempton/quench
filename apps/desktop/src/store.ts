import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ContextView } from "./generated/ContextView";
import type { MachineView } from "./generated/MachineView";
import type { RecentView } from "./generated/RecentView";

type Status = "idle" | "loading" | "ready" | "error";

interface ShellState {
  machine: MachineView | null;
  recent: RecentView[];
  view: ContextView | null;
  openPath: string | null;
  status: Status;
  error: string | null;
  init: () => Promise<void>;
  open: (path: string) => Promise<void>;
  pick: () => Promise<void>;
}

export const useShellStore = create<ShellState>((set, get) => ({
  machine: null,
  recent: [],
  view: null,
  openPath: null,
  status: "idle",
  error: null,

  init: async () => {
    const [machine, recent, launch] = await Promise.all([
      invoke<MachineView>("machine"),
      invoke<RecentView[]>("recent"),
      invoke<string | null>("launch_project"),
    ]);
    set({ machine, recent });
    const first = launch ?? recent[0]?.path;
    if (first) await get().open(first);
  },

  open: async (path) => {
    set({ status: "loading", error: null, openPath: path });
    try {
      const view = await invoke<ContextView>("open_project", { path });
      const recent = await invoke<RecentView[]>("recent");
      set({ view, recent, status: "ready" });
    } catch (err) {
      set({ status: "error", error: String(err) });
    }
  },

  pick: async () => {
    const path = await invoke<string | null>("pick_project");
    if (path) await get().open(path);
  },
}));
