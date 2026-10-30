// One handler per working stage (PIP **Code**).

import type { Handlers } from "../handlers.ts";
import { buildHandler } from "./build.ts";
import { ciHandler } from "./ci.ts";
import { designHandler } from "./design.ts";
import { gateHandler, mergeHandler } from "./gate.ts";
import { planHandler } from "./plan.ts";
import { proofHandler } from "./proof.ts";
import { publishHandler } from "./publish.ts";
import { reviewHandler } from "./review.ts";
import { deployHandler, e2eHandler, revertHandler, rollbackHandler } from "./ship.ts";
import { pickHandler } from "./start.ts";
import { verifyHandler } from "./verify.ts";

export function handlers(): Handlers {
  return {
    pick: pickHandler,
    design: designHandler,
    plan: planHandler,
    build: buildHandler,
    verify: verifyHandler,
    proof: proofHandler,
    publish: publishHandler,
    ci: ciHandler,
    review: reviewHandler,
    gate: gateHandler,
    merge: mergeHandler,
    deploy: deployHandler,
    e2e: e2eHandler,
    rollback: rollbackHandler,
    revert: revertHandler,
  };
}
