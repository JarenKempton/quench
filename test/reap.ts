import { rmSync } from "node:fs";

for await (const _ of Bun.stdin.stream());
rmSync(process.argv[2]!, { recursive: true, force: true, maxRetries: 5 });
