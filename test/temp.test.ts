import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

const child = `console.log(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "child-")))`;

test("a child process makes its temp dirs inside the run's temp root", async () => {
  const sync = Bun.spawnSync([process.execPath, "-e", child]).stdout.toString().trim();
  const async = (
    await new Response(Bun.spawn([process.execPath, "-e", child]).stdout).text()
  ).trim();
  expect(basename(tmpdir())).toStartWith("quench-test-");
  expect([dirname(sync), dirname(async)]).toEqual([tmpdir(), tmpdir()]);
});
