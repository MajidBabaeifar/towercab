import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Forks, not threads: a test spawns many git processes, and spawning from a big multi-threaded
    // process is slow (the suite took 4x as long).
    pool: "forks",
    testTimeout: 20_000,
    env: { NODE_NO_WARNINGS: "1" },
  },
});
