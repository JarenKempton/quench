import index from "./dist/index.html" with { type: "file" };
import script from "./dist/app.js" with { type: "file" };
import style from "./dist/index.css" with { type: "file" };
import sans from "./dist/geist-latin-wght-normal.woff2" with { type: "file" };
import mono from "./dist/geist-mono-latin-wght-normal.woff2" with { type: "file" };

export const files = {
  "index.html": index,
  "app.js": script,
  "index.css": style,
  "geist-latin-wght-normal.woff2": sans,
  "geist-mono-latin-wght-normal.woff2": mono,
};
