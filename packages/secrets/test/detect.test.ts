import { expect, test } from "bun:test";
import { detect, detectInFile, masked, scrubbed, sshKeyEncrypted } from "../src/index.ts";
import { goRegex } from "../src/go-regex.ts";
import { rules } from "../src/rules.ts";

const FAKE_BODY = "FakeQuenchTestValue0123456789abcdefg";
const fakeGithub = () => "ghp_" + FAKE_BODY;

test("every vendored gitleaks rule with a pattern compiles", () => {
  expect(rules.length).toBeGreaterThan(200);
});

test("detects a provider token and names its provider", () => {
  const found = detect(`export GH_TOKEN=${fakeGithub()}\n`);
  expect(found.map((d) => [d.rule, d.provider])).toEqual([["github-pat", "github"]]);
});

test("the entropy check drops placeholder values", () => {
  expect(detect(`token: ghp_${"x".repeat(36)}`)).toEqual([]);
});

test("file scans also report secret-named plaintext values", () => {
  const found = detectInFile("[default]\npassword = Quench-fake-pass-42\n");
  expect(found.map((d) => d.rule)).toEqual(["secret-named-value"]);
  expect(detectInFile("token = ${GH_TOKEN}\n")).toEqual([]);
});

test("masks keep four characters and a hash, never the value", () => {
  const shown = masked(fakeGithub());
  expect(shown).toMatch(/^ghp_…[0-9a-f]{8}$/);
  expect(shown).not.toContain(FAKE_BODY.slice(0, 8));
  const command = scrubbed(`curl -H "Authorization: token ${fakeGithub()}" https://api.github.com`);
  expect(command).not.toContain(FAKE_BODY.slice(0, 8));
  expect(command).toContain("ghp_…");
});

test("Go inline case flags apply to the rest of their group only", () => {
  const regex = goRegex("\\b(p8e-(?i)[a-z]{4})", "");
  expect(regex.test("p8e-AbCd")).toBe(true);
  expect(regex.test("P8E-abcd")).toBe(false);
  expect(goRegex("(?i)(a|(?-i:B))", "").test("b")).toBe(false);
});

test("recognises unencrypted and encrypted OpenSSH keys", () => {
  const key = (cipher: string) => {
    const name = Buffer.from(cipher);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length);
    const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), length, name]).toString("base64");
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  };
  expect(sshKeyEncrypted(key("none"))).toBe(false);
  expect(sshKeyEncrypted(key("aes256-ctr"))).toBe(true);
  expect(sshKeyEncrypted("-----BEGIN ENCRYPTED PRIVATE KEY-----\n")).toBe(true);
});
