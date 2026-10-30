import { cp, mkdir, rm } from "node:fs/promises";
const root = import.meta.dir;
const out = `${root}/dist`;
await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const name of ["index.html", "style.css", "page.js"])
  await cp(`${root}/${name}`, `${out}/${name}`);
console.log(out);
