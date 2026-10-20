import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ChangesView } from "./generated/ChangesView";
import type { ContextView } from "./generated/ContextView";
import type { MachineView } from "./generated/MachineView";
import type { RecentView } from "./generated/RecentView";

type Status = "idle" | "loading" | "ready" | "error";

interface ShellState {
  machine: MachineView | null;
  recent: RecentView[];
  view: ContextView | null;
  changes: ChangesView | null;
  openPath: string | null;
  status: Status;
  error: string | null;
  init: () => Promise<void>;
  open: (path: string) => Promise<void>;
  pick: () => Promise<void>;
  stage: (skill: string, value: string | null) => Promise<void>;
  run: (command: "apply" | "discard" | "undo") => Promise<void>;
  refreshAfterError: (error: string) => Promise<void>;
}

export const useShellStore = create<ShellState>((set, get) => ({
  machine: null,
  recent: [],
  view: null,
  changes: null,
  openPath: null,
  status: "idle",
  error: null,

  init: async () => {
    try {
      const [machine, recent, launch, changes] = await Promise.all([
        invoke<MachineView>("machine"),
        invoke<RecentView[]>("recent"),
        invoke<string | null>("launch_project"),
        invoke<ChangesView>("changes"),
      ]);
      set({ machine, recent, changes });
      const first = launch ?? recent[0]?.path;
      if (first) await get().open(first);
    } catch (err) {
      set({ status: "error", error: String(err) });
    }
  },

  open: async (path) => {
    set({ status: "loading", error: null });
    try {
      const view = await invoke<ContextView>("open_project", { path });
      const recent = await invoke<RecentView[]>("recent");
      set({ view, recent, openPath: view.project.root, status: "ready" });
    } catch (err) {
      set({ status: "error", error: `${path}: ${String(err)}` });
    }
  },

  pick: async () => {
    const path = await invoke<string | null>("pick_project");
    if (path) await get().open(path);
  },

  stage: async (skill, value) => {
    const path = get().openPath;
    if (!path) return;
    try {
      const changes = await invoke<ChangesView>("stage_skill", { path, skill, value });
      set({ changes });
      await get().open(path);
    } catch (err) {
      await get().refreshAfterError(String(err));
    }
  },

  run: async (command) => {
    try {
      const changes = await invoke<ChangesView>(command);
      set({ changes });
      const path = get().openPath;
      if (path) await get().open(path);
    } catch (err) {
      await get().refreshAfterError(String(err));
    }
  },

  refreshAfterError: async (error) => {
    const changes = await invoke<ChangesView>("changes").catch(() => get().changes);
    const path = get().openPath;
    const view = path
      ? await invoke<ContextView>("open_project", { path }).catch(() => get().view)
      : get().view;
    set({ changes, view, error, status: "error" });
  },
}));
