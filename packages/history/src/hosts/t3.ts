import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { z } from "zod";
import type { HarnessId, SenderEvidence, Session, SessionEnricher } from "../model.ts";

/** T3's projected link between a host conversation and a harness-native session. */
const ProviderThread = z.object({
  /** T3 conversation ID; used to find messages belonging to this host thread. */
  appThreadId: z.string(),
  /** Native session reference, when T3 recorded one; absent references cannot establish a match. */
  nativeThreadRef: z
    .object({
      /** T3's provider driver name, mapped here to a harness ID rather than exposed to analysis. */
      driver: z.string(),
      /** Session ID from the harness's own history, not the T3 conversation ID. */
      nativeId: z.string(),
      /** Only `strong` links are eligible; other values do not establish session ownership. */
      strength: z.string(),
    })
    .nullish(),
});

/** T3 message provenance; a `user` transport role alone does not establish human authorship. */
const Message = z.object({
  /** T3's message ID, retained as evidence; it is not a shared native-harness message ID. */
  id: z.string(),
  /** Owning T3 conversation; must agree with the linked provider thread. */
  threadId: z.string(),
  /** Transport role; only `user` messages are candidates for sender enrichment. */
  role: z.string(),
  /** Exact message text; repeated or nonidentical text is not matched heuristically. */
  text: z.string(),
  /** Host creation time, parsed and compared with the harness timestamp during matching. */
  createdAt: z.string(),
  /** Explicit `agent` means automation; `user` requires a trusted interactive creation source. */
  createdBy: z.string().optional(),
  /** `web` or `mobile` corroborates `user`; imported `server` records do not prove a person typed them. */
  creationSource: z.string().optional(),
  /** Present on T3's own notices (PR watches, background work, restarts); never typed by a person. */
  notification: z.unknown().optional(),
  /** Present on T3's delegated-task results sent to the parent thread. */
  delegatedCompletion: z.unknown().optional(),
});

const drivers: Readonly<Record<string, HarnessId>> = {
  claudeAgent: "claude-code",
  codex: "codex",
  pi: "pi",
};

const MAX_DELIVERY_MS = 60_000;

export function openT3History(path: string): {
  enrich: SessionEnricher;
  warnings: string[];
  close(): void;
} {
  const warnings: string[] = [];
  let db: Database | undefined;
  let enrich: SessionEnricher = (session) => session;
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  try {
    statSync(path);
    db = new Database(path, { readonly: true });
    db.exec("BEGIN");
    const threads = db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM orchestration_v2_projection_provider_threads",
    );
    const messages = db.query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user'",
    );
    const links = new Map<string, Set<string>>();
    for (const row of threads.all()) {
      const thread = ProviderThread.parse(JSON.parse(row.payload_json));
      const ref = thread.nativeThreadRef;
      if (!ref || ref.strength !== "strong") continue;
      const harness = drivers[ref.driver];
      if (!harness) continue;
      const key = `${harness}:${ref.nativeId}`;
      const owners = links.get(key) ?? new Set<string>();
      owners.add(thread.appThreadId);
      links.set(key, owners);
    }
    let available = true;
    enrich = (session) => {
      if (!available) return session;
      const owners = links.get(`${session.harness}:${session.id}`);
      if (owners?.size !== 1) return session;
      const threadId = [...owners][0] as string;
      try {
        const recorded = messages
          .all(threadId)
          .map((row) => Message.parse(JSON.parse(row.payload_json)));
        return enrichSession(session, threadId, recorded);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          warn(
            "T3 history has malformed messages; affected sessions use harness/model attribution.",
          );
        } else {
          available = false;
          warn("T3 history could not be read; remaining senders use harness/model attribution.");
        }
        return session;
      }
    };
  } catch (error) {
    db?.close();
    db = undefined;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn("T3 history is unreadable or incompatible; using harness/model sender attribution.");
    }
  }
  return { enrich, warnings, close: () => db?.close() };
}

function enrichSession(
  session: Session,
  threadId: string,
  recorded: z.infer<typeof Message>[],
): Session {
  const byText = new Map<string, z.infer<typeof Message>[]>();
  for (const message of recorded) {
    if (message.threadId !== threadId || message.role !== "user") continue;
    byText.set(message.text, [...(byText.get(message.text) ?? []), message]);
  }
  const counts = new Map<string, number>();
  for (const event of session.events) {
    if (event.type === "message" && event.author === "user") {
      counts.set(event.text, (counts.get(event.text) ?? 0) + 1);
    }
  }
  return {
    ...session,
    events: session.events.map((event) => {
      if (
        event.type !== "message" ||
        event.author !== "user" ||
        !event.at ||
        event.sender ||
        event.origin === "typed" ||
        event.origin === "scheduled" ||
        counts.get(event.text) !== 1
      )
        return event;
      const matches = byText.get(event.text);
      if (matches?.length !== 1) return event;
      const message = matches[0] as z.infer<typeof Message>;
      const delay = event.at.getTime() - Date.parse(message.createdAt);
      if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELIVERY_MS) return event;
      const sender = senderOf(message);
      return sender ? { ...event, sender } : event;
    }),
  };
}

function senderOf(message: z.infer<typeof Message>): SenderEvidence | null {
  if (message.notification !== undefined || message.delegatedCompletion !== undefined)
    return { sender: "automation", source: "t3-code", messageId: message.id, notice: true };
  const sender =
    message.createdBy === "agent"
      ? "automation"
      : message.createdBy === "user" &&
          (message.creationSource === "web" || message.creationSource === "mobile")
        ? "person"
        : null;
  return sender ? { sender, source: "t3-code", messageId: message.id } : null;
}
