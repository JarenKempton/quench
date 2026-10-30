import { cp, mkdir, rm } from "node:fs/promises";

const root = import.meta.dir;
const out = `${root}/dist`;
await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const name of ["index.html", "style.css", "page.js", "hero-still.jpg"])
  await cp(`${root}/${name}`, `${out}/${name}`).catch(() => {});
const bundle = await Bun.build({
  entrypoints: [`${root}/forge.ts`],
  outdir: out,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "forge bundle failed");
for (const o of bundle.outputs) console.log(`${o.path} ${(o.size / 1024).toFixed(0)} KB`);
console.log(out);
