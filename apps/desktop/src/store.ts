import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Scan } from "./scan";

// Mirrors quench_core::AppInfo (serde-serialized across the invoke bridge).
interface AppInfo {
  name: string;
  core_version: string;
}

type ScanStatus = "idle" | "scanning" | "ready" | "error";

interface ShellState {
  /** Real core version once the bridge answers; null until then. No placeholder value. */
  coreVersion: string | null;
  /** Ask the Rust core who it is — proves the invoke contract end-to-end (hone#5). */
  connect: () => Promise<void>;

  /** Real scan of this machine once the core answers; null until then (hone#13). */
  scan: Scan | null;
  scanStatus: ScanStatus;
  /** Error text if the scan failed — surfaced honestly, not swallowed into empty data. */
  scanError: string | null;
  /** Run the real scanner in the core and hold its honest result. */
  runScan: () => Promise<void>;
}

// hone#7: Zustand is the shell's state tool. It now holds the scan (hone#13);
// the staged-mutation tray model that will also live here is still fog.
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

  scan: null,
  scanStatus: "idle",
  scanError: null,
  runScan: async () => {
    set({ scanStatus: "scanning", scanError: null });
    try {
      const scan = await invoke<Scan>("scan");
      set({ scan, scanStatus: "ready" });
    } catch (err) {
      // No fake data on failure — show the error, keep the panels honestly empty.
      set({ scanStatus: "error", scanError: String(err) });
    }
  },
}));
