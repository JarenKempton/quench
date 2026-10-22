import { z } from "zod";

/** The main purpose of the user's reply to the preceding agent run. */
export const ReplyKind = z.enum(["correction", "new_request", "approval", "question", "info"]);
export type ReplyKind = z.infer<typeof ReplyKind>;

/** Person or automation attribution; a cached model guess may be overridden by structural evidence. */
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

/** Cached reply-classifier output, independent of theme membership and later sender enrichment. */
export const Verdict = z.object({
  /** What the reply mainly does: correct, request work, approve, question or provide information. */
  kind: ReplyKind,
  /** The classifier's authorship guess, not necessarily the final evidence-resolved sender. */
  sender: Sender,
  /** Confidence reported for the reply-kind answer, not confidence in the sender attribution. */
  confidence: z.number(),
});
export type Verdict = z.infer<typeof Verdict>;

export type Exchange = { assistantSaid: string; reply: string };

export type Judgment = Verdict | Error;

export interface Judge {
  readonly id: string;
  classify(exchanges: readonly Exchange[]): Promise<Judgment[]>;
}
