// LOOP-113: while the owner has paused Towercab, nothing it does changes GitHub. The loop wraps the
// forge, the tools and the intents store with these, so a write throws `PausedHold` before it
// happens, whichever stage asks for it. Reads pass through.

import type { IntentStore } from "../intents/types.ts";
import type { Tools } from "../tools.ts";

/** A change to GitHub was asked for while paused; nothing was changed, and it is asked again after resume. */
export class PausedHold extends Error {
  constructor(what: string) {
    super(`held while paused: ${what}`);
  }
}

/** The forge methods that change something on the host. */
const FORGE_WRITES: ReadonlySet<string> = new Set([
  "openPr",
  "updatePrBody",
  "commentOnPr",
  "markReady",
  "mergePr",
  "closePr",
  "updateBranch",
  "rerunFailed",
  "cancelRun",
  "createDeployment",
  "commentOnIssue",
  "addLabel",
  "removeLabels",
  "restoreSettings",
]);

/** The same object, whose write methods throw `PausedHold` while `held()`; `asOwner()` is wrapped too. */
export function holdWrites<T extends object>(host: T, held: () => boolean): T {
  return new Proxy(host, {
    get(target, key) {
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== "function") return v;
      if (key === "asOwner") {
        return (...a: unknown[]) => holdWrites((v as (...x: unknown[]) => object).apply(target, a), held);
      }
      if (typeof key === "string" && FORGE_WRITES.has(key)) {
        return (...a: unknown[]) =>
          held() ? Promise.reject(new PausedHold(key)) : (v as (...x: unknown[]) => unknown).apply(target, a);
      }
      return (v as (...x: unknown[]) => unknown).bind(target);
    },
  });
}

/** The same tools, but `git push` is held while `held()`. */
export function holdPushes(tools: Tools, held: () => boolean): Tools {
  return {
    run: (cmd, args, opts) =>
      held() && cmd === "git" && args.includes("push")
        ? Promise.reject(new PausedHold("git push"))
        : tools.run(cmd, args, opts),
    spawn: (spec) => tools.spawn(spec),
    which: (cmd) => tools.which(cmd),
    cutOff: () => tools.cutOff?.() ?? [],
  };
}

/** The same store, whose writes to the intents repo are held while `held()`. */
export function holdStore(store: IntentStore, held: () => boolean): IntentStore {
  const hold = (what: string) => Promise.reject(new PausedHold(what));
  return new Proxy(store, {
    get(target, key) {
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== "function") return v;
      if (key === "add" || key === "update" || key === "editFeatures") {
        return (...a: unknown[]) =>
          held() ? hold(`intents ${String(key)}`) : (v as (...x: unknown[]) => unknown).apply(target, a);
      }
      return (v as (...x: unknown[]) => unknown).bind(target);
    },
  });
}
