export type Prompt = {
  ask: (question: string, secret?: boolean) => Promise<string | null>;
  close: () => void;
};

export function prompt(
  input: NodeJS.ReadStream = process.stdin,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Prompt {
  let buffer = "";
  let ended = false;
  let started = false;
  let wake: (() => void) | null = null;
  const onData = (chunk: string | Buffer) => {
    buffer += chunk.toString();
    wake?.();
  };
  const onEnd = () => {
    ended = true;
    wake?.();
  };
  const more = () => new Promise<void>((resolve) => (wake = resolve)).then(() => (wake = null));
  const raw = (on: boolean) => {
    if (input.isTTY) input.setRawMode(on);
  };

  const line = (): string | null | undefined => {
    const end = buffer.indexOf("\n");
    if (end >= 0) {
      const text = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      return text;
    }
    if (!ended) return undefined;
    const rest = buffer;
    buffer = "";
    return rest || null;
  };

  let typed = "";
  const keys = (): string | null | undefined => {
    while (buffer) {
      const key = buffer[0] as string;
      buffer = buffer.slice(1);
      if (key === "\r" || key === "\n") return typed;
      if (key === "\x03") {
        raw(false);
        write("\n");
        process.exit(130);
      }
      if (key === "\x04" && !typed) return null;
      if (key === "\x7f" || key === "\b") typed = typed.slice(0, -1);
      else if (key >= " ") typed += key;
    }
    return ended ? null : undefined;
  };

  return {
    ask: async (question, secret = false) => {
      if (!started) {
        started = true;
        input.setEncoding("utf8");
        input.on("data", onData);
        input.on("end", onEnd);
      }
      input.resume();
      const hidden = secret && Boolean(input.isTTY);
      write(question);
      if (hidden) raw(true);
      typed = "";
      try {
        for (;;) {
          const answer = hidden ? keys() : line();
          if (answer !== undefined) return answer;
          await more();
        }
      } finally {
        if (hidden) {
          raw(false);
          write("\n");
        }
        input.pause();
      }
    },
    close: () => {
      if (!started) return;
      input.off("data", onData);
      input.off("end", onEnd);
      raw(false);
      input.pause();
      input.destroy();
    },
  };
}
