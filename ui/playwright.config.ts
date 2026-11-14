// Screenshot tests (UI-69): the fixture server in Chromium, light, dark and phone.

import { defineConfig, devices } from "@playwright/test";

// Each checkout gets its own port, so parallel builds on one machine don't collide on the fixture server.
const own = [...process.cwd()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000;
const PORT = Number(process.env.TOWERCAB_FIXTURE_PORT ?? 7398 + own);

export default defineConfig({
  testDir: ".",
  testMatch: [
    "screenshots.spec.ts",
    "stages.spec.ts",
    "proposed.spec.ts",
    "readiness.spec.ts",
    "exits.spec.ts",
    "board-sort.spec.ts",
    "limits.spec.ts",
    "shadow.spec.ts",
    "overview-order.spec.ts",
    "autonomy.spec.ts",
    "autonomy-inbox.spec.ts",
    "inbox.spec.ts",
    "inbox-keys.spec.ts",
    "palette.spec.ts",
    "folds.spec.ts",
    "clarity.spec.ts",
  ],
  outputDir: "screenshots/.results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `node --disable-warning=ExperimentalWarning ui/fixture.ts --port ${PORT}`,
    cwd: "..",
    url: `http://localhost:${PORT}/api/state`,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  },
});
