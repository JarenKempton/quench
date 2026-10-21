import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["packages/*/test/fixtures/**"],
  },
  lint: {
    ignorePatterns: ["packages/*/test/fixtures/**"],
    options: { typeAware: true, typeCheck: true },
  },
});
