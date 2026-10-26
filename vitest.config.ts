import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    testTimeout: 20_000,
    env: { NODE_NO_WARNINGS: "1" },
  },
});
