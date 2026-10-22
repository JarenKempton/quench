import { z } from "zod";

export const ReplyKind = z.enum(["correction", "new_request", "approval", "question", "info"]);
export type ReplyKind = z.infer<typeof ReplyKind>;

export const Sender = z.enum(["person", "automation"]);
export type Sender = z.infer<typeof Sender>;

export const replyKindMeaning: Record<ReplyKind, string> = {
  correction: "Says the assistant was wrong, ignored an instruction, or went the wrong direction",
  new_request: "Asks for new or additional work",
  approval: "Approves, agrees, or says to continue",
  question: "Asks a question",
  info: "Gives information or answers a question",
};

export const senderMeaning: Record<Sender, string> = {
  person: "The person who owns this work typed it themselves, in first person",
  automation:
    "Another AI agent, bot or tool wrote it: it refers to the owner in third person, coordinates other agents' tasks, or reports status",
};

export const Verdict = z.object({ kind: ReplyKind, sender: Sender, confidence: z.number() });
export type Verdict = z.infer<typeof Verdict>;

export type Exchange = { assistantSaid: string; reply: string };

export type Judgment = Verdict | Error;

export interface Judge {
  readonly id: string;
  classify(exchanges: readonly Exchange[]): Promise<Judgment[]>;
}
