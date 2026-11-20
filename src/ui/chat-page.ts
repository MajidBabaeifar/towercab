// CHAT-3: `GET /api/intents/<id>/chat`, the intent's thread from the page's sources.

import { join } from "node:path";
import { forIntent } from "../mission.ts";
import { chatOf } from "./chat.ts";
import type { UiSources } from "./state.ts";
import type { ChatPage } from "./view.ts";

export function chatPage(src: UiSources, intent: string, before?: number): ChatPage {
  return chatOf(
    { db: src.db, runsRoot: join(src.home.root, "runs") },
    intent,
    forIntent(src.db, intent),
    before,
  );
}
