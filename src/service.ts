// The systemd user service (LOOP-2): up, down, restart, logs. It runs the loop from this checkout.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Tools } from "./tools.ts";

export const SERVICE = "towercab.service";

/** The unit file text (loop.md **Unit**) for a checkout and the node binary's directory. */
export function unitText(checkout: string, nodeDir: string): string {
  return `[Unit]
Description=Towercab

[Service]
ExecStart=${join(checkout, "bin", "towercab")} run --watch
Environment=PATH=${nodeDir}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

export function unitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const config = xdg?.startsWith("/") ? xdg : join(homedir(), ".config");
  return join(config, "systemd", "user", SERVICE);
}

/** The checkout this program runs from (`src/..`). */
export function checkoutRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

async function systemctl(tools: Tools, args: string[]): Promise<void> {
  const r = await tools.run("systemctl", ["--user", ...args], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`systemctl ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
}

export async function up(
  tools: Tools,
  checkout = checkoutRoot(),
  nodeDir = dirname(process.execPath),
): Promise<string> {
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitText(checkout, nodeDir));
  await systemctl(tools, ["daemon-reload"]);
  await systemctl(tools, ["enable", "--now", SERVICE]);
  return `towercab is running from ${checkout} (${path})`;
}

export async function down(tools: Tools): Promise<string> {
  await systemctl(tools, ["disable", "--now", SERVICE]);
  return "towercab stopped; its missions continue when it starts again";
}

export async function restart(tools: Tools): Promise<string> {
  await systemctl(tools, ["restart", SERVICE]);
  return "towercab restarted";
}

/** The argv `logs` hands over to (the CLI runs it in the foreground). */
export function logsArgv(): string[] {
  return ["journalctl", "--user", "-u", "towercab", "-f"];
}
