export const STEPS = ["agents", "summary", "judge", "hub", "ui"] as const;

export const SECTIONS = ["projects", "mcp", "instructions", "skills", "failures"] as const;

export const HOME_FLAGS = {
  "claude-home": "claude-code",
  "codex-home": "codex",
  "pi-home": "pi",
} as const;
