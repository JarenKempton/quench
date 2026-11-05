import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Home } from "../home.ts";
import type { Event, HarnessId, SenderEvidence, Session, SessionEnricher } from "../model.ts";

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
  attachments: z.array(z.unknown()).nullish(),
});

const drivers: Readonly<Record<string, HarnessId>> = {
  claudeAgent: "claude-code",
  codex: "codex",
  pi: "pi",
};

const MAX_DELIVERY_MS = 60 * 60_000;

export const t3State = (home: Home) => join(home.dir, ".t3", "userdata", "statev2.sqlite");

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
  for (const list of byText.values()) list.sort((a, b) => time(a) - time(b));
  const sent = new Map<string, Extract<Event, { type: "message" }>[]>();
  for (const event of session.events) {
    if (event.type !== "message" || event.author !== "user") continue;
    const key = hostText(event.text, byText);
    if (key !== null) sent.set(key, [...(sent.get(key) ?? []), event]);
  }
  const senders = new Map<Event, SenderEvidence>();
  for (const [text, events] of sent) {
    const messages = byText.get(text)!;
    if (messages.length !== events.length) continue;
    events.forEach((event, i) => {
      const message = messages[i]!;
      const delay = event.at ? event.at.getTime() - time(message) : NaN;
      const sender = senderOf(message);
      if (
        sender &&
        !event.sender &&
        event.origin !== "typed" &&
        event.origin !== "scheduled" &&
        Number.isFinite(delay) &&
        delay >= 0 &&
        delay <= MAX_DELIVERY_MS
      )
        senders.set(event, sender);
    });
  }
  return {
    ...session,
    events: session.events.map((event) => {
      const sender = senders.get(event);
      return sender ? { ...event, sender } : event;
    }),
  };
}

const time = (message: z.infer<typeof Message>) => Date.parse(message.createdAt);

const ATTACHED = /(?:\n\n\[Attached image "[^"\n]*" is saved at: [^\n]*\])+$/;

function hostText(text: string, byText: Map<string, z.infer<typeof Message>[]>): string | null {
  if (byText.has(text)) return text;
  const bare = text.replace(ATTACHED, "");
  return bare !== text && byText.get(bare)?.every((m) => m.attachments?.length) ? bare : null;
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

export type HostMessage = { thread: string; role: string; text: string; at: Date | null };

export function* t3Messages(path: string): Generator<HostMessage> {
  try {
    statSync(path);
  } catch {
    return;
  }
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM orchestration_v2_projection_messages",
    );
    for (const row of rows.iterate()) {
      const message = Message.safeParse(JSON.parse(row.payload_json));
      if (!message.success) continue;
      const at = new Date(message.data.createdAt);
      yield {
        thread: message.data.threadId,
        role: message.data.role,
        text: message.data.text,
        at: Number.isNaN(at.getTime()) ? null : at,
      };
    }
  } finally {
    db.close();
  }
}
