import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientDir } from "../src/client.ts";
import { git, lines, Owner, PASSWORD, quench, run, sharedSource, temp } from "./helpers.ts";

const servers: ReturnType<typeof quench>[] = [];
afterAll(async () => {
  for (const proc of servers) {
    proc.kill();
    await proc.exited;
  }
});

const PATH = "skills/writing/commit-style/SKILL.md";
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

test("pair, propose, token approval fails, password approval commits, owner edit makes the next one stale", async () => {
  const hubHome = temp("hub-home");
  const data = join(hubHome, "data");
  expect((await run(hubHome, ["hub", "import", await sharedSource(), "--data", data])).code).toBe(
    0,
  );
  const server = quench(hubHome, ["hub", "serve", "--data", data, "--listen", "127.0.0.1:0"], {
    QUENCH_HUB_PASSWORD: PASSWORD,
  });
  servers.push(server);
  const banner = await lines(server, /Certificate pin sha256:[0-9a-f]{64}\n/);
  const url = /Quench hub at (https:\/\/\S+)/.exec(banner)![1]!;
  const cert = readFileSync(join(data, "tls", "cert.pem"), "utf8");
  const headOf = () => git(data, "--git-dir", join(data, "skills.git"), "rev-parse", "main");

  const owner = new Owner(url, cert);
  await owner.login();
  const laptop = temp("laptop");
  const added = await owner.addMachine("laptop");
  const paired = await run(laptop, [
    "connect",
    added.url,
    "--code",
    added.code,
    "--pin",
    added.pin!,
  ]);
  expect(paired.code).toBe(0);

  const noAccess = await run(laptop, ["skill", "list"]);
  expect(noAccess.code).toBe(1);
  expect(noAccess.stderr).toContain("no proposal access");

  const allowed = await owner.allowProposals("laptop");
  expect(allowed.command).toMatch(
    /^quench connect https:\/\/127\.0\.0\.1:\d+ --code \S+ --pin sha256:/,
  );
  const access = await run(laptop, [
    "connect",
    allowed.url,
    "--code",
    allowed.code,
    "--pin",
    allowed.pin!,
  ]);
  expect(access.stderr).toBe("");
  expect(access.stdout).toContain("Proposal access");

  const listed = JSON.parse((await run(laptop, ["skill", "list", "--json"])).stdout) as {
    skills: { name: string; treeHash: string }[];
  };
  expect(listed.skills.map((s) => s.name)).toEqual([
    "commit-style",
    "review-checklist",
    "scratchpad",
  ]);
  const base = listed.skills[0]!.treeHash;
  const shown = await run(laptop, ["skill", "show", "commit-style"]);
  expect(shown.stdout).toContain("Use conventional commits, revised.");
  expect((await run(laptop, ["skill", "show", "deploy-notes"])).code).toBe(1);

  const draft = join(laptop, "commit-style.md");
  const proposed = `${shown.stdout}\nKeep the subject under 72 characters.\n`;
  writeFileSync(draft, proposed);
  const diff = await run(laptop, ["skill", "diff", "commit-style", draft]);
  expect(diff.stdout).toContain(`+++ b/${PATH}`);
  expect(diff.stdout).toContain("+Keep the subject under 72 characters.");

  const submitted = await run(laptop, [
    "skill",
    "propose",
    "commit-style",
    draft,
    "--base",
    base,
    "--agent",
    "synthetic-agent",
    "--harness",
    "claude-code",
    "--session",
    "session-1",
    "--json",
  ]);
  expect(submitted.stderr).toBe("");
  const receipt = JSON.parse(submitted.stdout) as { id: number; baseTreeHash: string };
  expect(receipt.baseTreeHash).toBe(base);

  const before = await headOf();
  const review = await (await owner.fetch(`/proposal?id=${receipt.id}`)).text();
  expect(review).toContain('synthetic-agent <span class="claim">(claimed, not verified)</span>');
  expect(review).toContain("No evidence attached.");
  const fleetDir = clientDir(laptop);
  for (const file of ["token", "propose-token"]) {
    const token = readFileSync(join(fleetDir, file), "utf8").trim();
    const attempt = await fetch(`${url}/proposal/approve`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        origin: url,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        id: String(receipt.id),
        base: before,
        password: PASSWORD,
        csrf: owner.csrf,
      }).toString(),
      tls: { ca: cert },
    });
    expect([file, attempt.status]).toEqual([file, 401]);
  }
  expect(await headOf()).toBe(before);

  const approved = await owner.post("/proposal/approve", {
    id: String(receipt.id),
    base: field(review, "base"),
    password: PASSWORD,
  });
  expect(approved.status).toBe(303);
  const afterApproval = await headOf();
  expect(afterApproval).not.toBe(before);
  expect(await git(data, "--git-dir", join(data, "skills.git"), "rev-parse", "main^")).toBe(before);
  expect(await git(data, "--git-dir", join(data, "skills.git"), "show", `main:${PATH}`)).toBe(
    proposed.trimEnd(),
  );
  expect((await run(laptop, ["skill", "show", "commit-style"])).stdout).toBe(proposed);

  const nextBase = (
    JSON.parse((await run(laptop, ["skill", "list", "--json"])).stdout) as {
      skills: { name: string; treeHash: string }[];
    }
  ).skills[0]!.treeHash;
  writeFileSync(draft, `${proposed}Explain why in the body.\n`);
  const second = JSON.parse(
    (await run(laptop, ["skill", "propose", "commit-style", draft, "--base", nextBase, "--json"]))
      .stdout,
  ) as { id: number };

  const ownerEdit = `${proposed}Wrap the body at 72 columns.\n`;
  const preview = await (
    await owner.post("/edit", {
      path: PATH,
      base: afterApproval,
      content: ownerEdit,
      action: "preview",
    })
  ).text();
  expect(
    (
      await owner.post("/edit", {
        path: PATH,
        base: afterApproval,
        content: ownerEdit,
        previewed: field(preview, "previewed"),
        action: "save",
      })
    ).status,
  ).toBe(303);
  const afterEdit = await headOf();

  const stalePage = await (await owner.fetch(`/proposal?id=${second.id}`)).text();
  expect(stalePage).toContain('id="stale"');
  expect(stalePage).toContain("Approval is blocked");
  expect(stalePage).not.toContain('action="/proposal/approve"');
  const threeWay = /<pre id="three-way">([\s\S]*?)<\/pre>/.exec(stalePage)![1]!;
  expect(threeWay).toContain("&lt;&lt;&lt;&lt;&lt;&lt;&lt; current");
  expect(threeWay).toContain("||||||| base");
  expect(threeWay).toContain("&gt;&gt;&gt;&gt;&gt;&gt;&gt; proposed");
  expect(threeWay).toContain("Wrap the body at 72 columns.");
  expect(threeWay).toContain("Explain why in the body.");

  const blocked = await owner.post("/proposal/approve", {
    id: String(second.id),
    base: afterEdit,
    password: PASSWORD,
  });
  expect(blocked.status).toBe(409);
  expect(await blocked.text()).toContain("stale; nothing was committed");
  expect(await headOf()).toBe(afterEdit);
  expect(await git(data, "--git-dir", join(data, "skills.git"), "show", `main:${PATH}`)).toBe(
    ownerEdit.trimEnd(),
  );

  const dashboard = await (await owner.fetch("/")).text();
  expect(dashboard).toContain(`#${receipt.id}</a></td><td>commit-style</td><td>laptop</td>`);
  expect(dashboard).toContain('<span class="err">stale</span>');
}, 60_000);
