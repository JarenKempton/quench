import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detect,
  detectInFile,
  machineKey,
  masker,
  redacted,
  sshKeyEncrypted,
  toolConfigFiles,
} from "../src/index.ts";
import { goRegex } from "../src/go-regex.ts";
import { passwords } from "../src/mask.ts";
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

const mask = masker(randomBytes(32));

test("masks keep four characters and a keyed tag, never the value", () => {
  const shown = mask.masked(fakeGithub());
  expect(shown).toMatch(/^ghp_…[0-9a-f]{8}$/);
  expect(shown).not.toContain(FAKE_BODY.slice(0, 8));
  expect(masker(randomBytes(32)).masked(fakeGithub())).not.toBe(shown);
  const command = mask.scrubbed(
    `curl -H "Authorization: token ${fakeGithub()}" https://api.github.com`,
  );
  expect(command).not.toContain(FAKE_BODY.slice(0, 8));
  expect(command).toContain("ghp_…");
});

test("scrubbed commands mask short passwords", () => {
  for (const [command, password] of [
    ["sshpass -p 'Fake#Pw42x' ssh deploy@host", "Fake#Pw42x"],
    ["mysql -pFakePw_2026 -u root", "FakePw_2026"],
    ["PGPASSWORD=FakePg_77 psql", "FakePg_77"],
    ['mysql -p "Spaced Secret99" -u root', "Spaced Secret99"],
    ["mysqldump --password 'Long Pass Phrase 1' db", "Long Pass Phrase 1"],
    ["psql postgresql://u:PgUrlPw9@h/db", "PgUrlPw9"],
    ["redis-cli -h cache -a RedisPw_31 ping", "RedisPw_31"],
    ["htpasswd -b .htpasswd admin HtPw_4411", "HtPw_4411"],
    ["htpasswd -nb admin HtPwN_552", "HtPwN_552"],
  ]) {
    const shown = mask.scrubbed(command!);
    expect(shown).not.toContain(password!);
    expect(shown).toContain(mask.masked(password!));
  }
});

test("the masking key is random per machine and kept private", async () => {
  const home = await mkdtemp(join(tmpdir(), "quench-key-"));
  const key = await machineKey(home);
  expect(key.length).toBe(32);
  expect((await machineKey(home)).equals(key)).toBe(true);
  if (process.platform !== "win32")
    expect((await stat(join(home, ".quench/local/secrets.key"))).mode & 0o777).toBe(0o600);
});

test("GitHub CLI and gcloud configs resolve per platform", () => {
  expect(
    toolConfigFiles("C:\\Users\\a", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }),
  ).toEqual([
    [join("C:\\Users\\a\\AppData\\Roaming", "GitHub CLI", "hosts.yml"), "GitHub CLI"],
    [
      join("C:\\Users\\a\\AppData\\Roaming", "gcloud", "application_default_credentials.json"),
      "gcloud ADC",
    ],
  ]);
  expect(toolConfigFiles("/home/a", "linux", {}).map(([path]) => path)).toEqual([
    join("/home/a", ".config", "gh", "hosts.yml"),
    join("/home/a", ".config", "gcloud", "application_default_credentials.json"),
  ]);
  expect(toolConfigFiles("/home/a", "linux", { GH_CONFIG_DIR: "/gh" })[0]![0]).toBe(
    join("/gh", "hosts.yml"),
  );
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

test("rules with a gitleaks path filter only match files on that path", () => {
  const text = 'admin_password = "fakequenchpw42"\n';
  const rule = (path?: string) => detect(text, path).map((d) => d.rule);
  expect(rule()).not.toContain("hashicorp-tf-password");
  expect(rule("/repo/notes.md")).not.toContain("hashicorp-tf-password");
  expect(rule("/repo/main.tf")).toContain("hashicorp-tf-password");
  expect(rule("C:\\repo\\vars.HCL")).toContain("hashicorp-tf-password");
});

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("a jwt names its issuer and an http-auth header names its host", () => {
  const jwt = [
    base64url({ alg: "HS256", typ: "JWT" }),
    base64url({ iss: "https://auth.example.test", sub: "fake-quench-user" }),
    "FakeQuenchSignature0123456789",
  ].join(".");
  expect(detect(`token: ${jwt}\n`).map((d) => [d.rule, d.issuer])).toEqual([
    ["jwt", "https://auth.example.test"],
  ]);
  const curl =
    'curl -H "Authorization: Bearer FakeQuenchBearer0123456789" https://API.example.test/v1';
  expect(detect(curl).map((d) => [d.provider, d.issuer])).toEqual([
    ["http-auth", "api.example.test"],
  ]);
});

test("a jwt issuer loses control characters", () => {
  const jwt = [
    base64url({ alg: "HS256", typ: "JWT" }),
    base64url({ iss: "\u001b[2Jhttps://auth.example.test\r\nFAKE", sub: "fake-quench-user" }),
    "FakeQuenchSignature0123456789",
  ].join(".");
  expect(detect(`token: ${jwt}\n`).map((d) => d.issuer)).toEqual([
    "[2Jhttps://auth.example.testFAKE",
  ]);
});

test("credential flags are masked whatever their length, without new findings", () => {
  for (const [text, value] of [
    ["deploy --token=shortpw", "shortpw"],
    ["deploy --api-key zzzzzzzzzzzz", "zzzzzzzzzzzz"],
    ["deploy --client-secret 'ab'", "ab"],
    ["refused: Authorization: Bearer cnry", "cnry"],
  ]) {
    expect(detectInFile(text!)).toEqual([]);
    expect(passwords(text!)).toEqual([]);
    expect(redacted(text!)).not.toContain(value!);
    expect(redacted(text!)).toContain("‹secret›");
    expect(mask.scrubbed(text!)).not.toContain(value!);
  }
  expect(redacted("--password=p --force")).toBe("--password=‹secret› --force");
});

test("redaction masks each credential slot by position, leaving the text around it intact", () => {
  for (const [text, safe] of [
    ["git clone https://user:pw@host/r", "git clone https://user:‹secret›@host/r"],
    ["git clone https://tok@host/r", "git clone https://‹secret›@host/r"],
    ["curl -u a:b https://x", "curl -u ‹secret› https://x"],
    ["curl -uadmin:pw https://x", "curl -u‹secret› https://x"],
    ["deploy --token=-canary", "deploy --token=‹secret›"],
    ["deploy --token -canary", "deploy --token ‹secret›"],
    ["Authorization:ab", "Authorization:‹secret›"],
    ["Authorization: Bearer ab", "Authorization: Bearer ‹secret›"],
    ["--password=pass bypass", "--password=‹secret› bypass"],
    ["GITHUB_TOKEN=x make", "GITHUB_TOKEN=‹secret› make"],
    ["--api-key 'a b' --force", "--api-key '‹secret›' --force"],
    ["--password=https://u:pw@host", "--password=‹secret›"],
    ["pass passive --pass=p bypass", "pass passive --pass=‹secret› bypass"],
  ])
    expect(redacted(text!)).toBe(safe!);
});
