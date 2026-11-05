import { z } from "zod";

export const HarnessId = z.enum(["claude-code", "codex", "pi"]);
export type HarnessId = z.infer<typeof HarnessId>;
export const HARNESSES = HarnessId.options;

export const SkillName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const MachineName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
export const TreeHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type TreeHash = z.infer<typeof TreeHash>;
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const Remote = z.string().regex(/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._~-]+)+$/);

export const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("project"), remote: Remote }).strict(),
]);
export type Scope = z.infer<typeof Scope>;

export const Location = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }).strict(),
  z.object({ scope: z.literal("project"), remote: Remote, checkout: z.string() }).strict(),
]);
export type Location = z.infer<typeof Location>;

export const Timestamp = z.iso.datetime({ offset: true });
