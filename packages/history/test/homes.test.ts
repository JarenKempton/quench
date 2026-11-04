import { expect, test } from "bun:test";
import { join } from "node:path";
import { Home, harnessById } from "../src/index.ts";
import { t3State } from "../src/hosts/t3.ts";

test("harness homes and T3 state sit under the home on macOS, Linux and Windows", () => {
  for (const dir of ["/Users/a", "/home/a", "C:\\Users\\a"]) {
    const home = new Home(dir);
    expect(home.of(harnessById["claude-code"].home)).toBe(join(dir, ".claude"));
    expect(home.of(harnessById.codex.home)).toBe(join(dir, ".codex"));
    expect(home.of(harnessById.pi.home)).toBe(join(dir, ".pi/agent"));
    expect(t3State(home)).toBe(join(dir, ".t3", "userdata", "statev2.sqlite"));
  }
  expect(new Home("/Users/a", { CODEX_HOME: "/c" }).of(harnessById.codex.home)).toBe("/c");
});
