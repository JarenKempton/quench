# Landing page

Static. No framework, no build step.

```sh
bun run --cwd site preview     # serves site/ on http://localhost:4350
bun run --cwd site build       # copies site/ into site/dist
bun run --cwd site shots       # full-page screenshots at 1440 and 390 into /tmp
```
