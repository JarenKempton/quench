import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "packages/*/test/fixtures/**",
      "packages/secrets/vendor/**",
      "packages/ui/dist/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "packages/*/test/fixtures/**",
      "packages/secrets/vendor/**",
      "packages/ui/dist/**",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    tasks: {
      quench: { command: "bun packages/cli/src/main.ts", cache: false },
      test: { command: "bun test", cache: false },
      ui: { command: "bun run --cwd packages/ui build", cache: false },
      compile: {
        command: "bun build --compile packages/cli/src/main.ts --outfile dist/quench",
        cache: false,
        dependsOn: ["ui"],
      },
    },
  },
});
