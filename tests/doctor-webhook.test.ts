// LOOP-147: `doctor` checks each webhook's URL file like the other secrets files, and never prints the URL.

import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { SECRET_URL, urlFile } from "./helpers/notify.ts";
import { FakeTools } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

async function lines(file: string) {
  const config = testConfig({ notify: { webhook: [{ name: "team", url_file: file }] } });
  return doctor({ config, home: testHome(), tools: new FakeTools(), github: null, quick: false });
}

test("doctor: a loose webhook url file fails with the chmod", async () => {
  const loose = urlFile(SECRET_URL, 0o644);
  const bad = await lines(loose);
  expect(bad.ok).toBe(false);
  expect(bad.lines).toContain(`webhook team: url_file ${loose} is readable by group or others: chmod 600 it`);
  const good = await lines(urlFile());
  expect(good.lines.filter((l) => l.startsWith("webhook team:"))).toHaveLength(1);
  expect(good.lines.find((l) => l.startsWith("webhook team:"))).toMatch(
    /^webhook team: minimal messages, url in /,
  );
  const plain = await lines(urlFile("http://hooks.example.com/T0K3N"));
  expect(plain.lines.find((l) => l.startsWith("webhook team:"))).toBe(
    "webhook team: http is only allowed for local addresses",
  );
  expect(JSON.stringify([bad.lines, good.lines, plain.lines])).not.toMatch(/T0K3N|chat\.example\.com/);
});
