const root = import.meta.dir;
const port = Number(process.env.PORT ?? 4350);
Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(`${root}${path === "/" ? "/index.html" : path}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`http://localhost:${port}`);
