export type Secrets = readonly (string | undefined)[];

export const redact = (text: string, secrets: Secrets): string =>
  secrets.reduce<string>((out, secret) => (secret ? out.split(secret).join("[key]") : out), text);

export function scrub<E>(error: E, secrets: Secrets): E {
  if (!(error instanceof Error)) return error;
  error.message = redact(error.message, secrets);
  if (error.stack) error.stack = redact(error.stack, secrets);
  scrub(error.cause, secrets);
  return error;
}
