import type Anthropic from "@anthropic-ai/sdk";
import type { FileEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { expectTypeOf, test } from "bun:test";
import type { z } from "zod";
import { ApiMessage, ApiUsage, Block } from "../src/harnesses/claude-code.ts";
import { Item, Line, Message } from "../src/harnesses/pi.ts";

type KeysOf<T> = T extends unknown ? keyof T : never;
type Unpublished<Schema extends z.ZodObject, Vendor> = Exclude<
  keyof Schema["shape"],
  KeysOf<Vendor>
>;
type Plain<T> = T extends object
  ? { [K in keyof T as string extends K ? never : K]: Plain<T[K]> }
  : T;
type Accepts<Schema extends z.ZodObject> = Plain<z.input<Schema>>;

type PiMessage = SessionMessageEntry["message"];
type PiContent = Exclude<Extract<PiMessage, { content: unknown }>["content"], string>[number];

test("vendor types resolve", () => {
  expectTypeOf<Anthropic.Message>().not.toBeAny();
  expectTypeOf<FileEntry>().not.toBeAny();
  expectTypeOf<PiMessage>().not.toBeAny();
});

test("Claude Code reads only fields the Anthropic SDK publishes, with compatible types", () => {
  expectTypeOf<Unpublished<typeof ApiUsage, Anthropic.Usage>>().toBeNever();
  expectTypeOf<Anthropic.Usage>().toExtend<Accepts<typeof ApiUsage>>();

  expectTypeOf<Unpublished<typeof ApiMessage, Anthropic.Message>>().toBeNever();
  expectTypeOf<Anthropic.Message>().toExtend<Accepts<typeof ApiMessage>>();

  type ContentBlock = Anthropic.TextBlock | Anthropic.ToolUseBlock | Anthropic.ToolResultBlockParam;
  expectTypeOf<Unpublished<typeof Block, ContentBlock>>().toBeNever();
  expectTypeOf<ContentBlock>().toExtend<Accepts<typeof Block>>();
});

test("Pi reads only fields the Pi packages publish, with compatible types", () => {
  expectTypeOf<Unpublished<typeof Line, FileEntry>>().toBeNever();
  expectTypeOf<FileEntry>().toExtend<Accepts<typeof Line>>();

  expectTypeOf<Unpublished<typeof Message, PiMessage>>().toBeNever();
  expectTypeOf<PiMessage>().toExtend<Accepts<typeof Message>>();

  expectTypeOf<Unpublished<typeof Item, PiContent>>().toBeNever();
  expectTypeOf<PiContent>().toExtend<Accepts<typeof Item>>();
});
