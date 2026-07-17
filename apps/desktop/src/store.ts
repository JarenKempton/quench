import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Mirrors hone_core::AppInfo (serde-serialized across the invoke bridge).
interface AppInfo {
  name: string;
  core_version: string;
}

interface ShellState {
  /** Real core version once the bridge answers; null until then. No placeholder value. */
  coreVersion: string | null;
  /** Ask the Rust core who it is — proves the invoke contract end-to-end (hone#5). */
  connect: () => Promise<void>;
}

// hone#7: Zustand is the shell's state tool. The staged-mutation tray model that
// will eventually live here is still fog — for now it holds one honest fact.
export const useShellStore = create<ShellState>((set) => ({
  coreVersion: null,
  connect: async () => {
    try {
      const info = await invoke<AppInfo>("app_info");
      set({ coreVersion: info.core_version });
    } catch {
      set({ coreVersion: null });
    }
  },
}));
