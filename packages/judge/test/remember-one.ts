import { VerdictCache } from "../src/index.ts";

const [dir, judge, reply] = process.argv.slice(2);
const cache = await VerdictCache.open(dir!, judge!);
await cache.remember([
  [
    { assistantSaid: "done", reply: reply! },
    { kind: "correction", sender: "person", confidence: 1 },
  ],
]);
