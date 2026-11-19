// FAST-7: a confirmed fast-lane intent's question gets the worker's recommendation as its answer. The owner
// sees what was chosen afterwards: on the Question comment, on the timeline and in one Telegram message.

import { fastConfirmed } from "../fast.ts";
import { agentOf, upsertStageComment } from "../github/comments.ts";
import type { Ctx } from "../handlers.ts";
import type { Intent } from "../intents/types.ts";
import type { Outcome } from "../machine.ts";
import { dataOf, type Mission } from "../mission.ts";
import type { PipeData } from "./common.ts";
import { currentPr, questionMd } from "./common.ts";
import type { Question } from "./schemas.ts";

/** One automatic answer, as the page lists it. */
export interface FastAnswer {
  question: string;
  answer: string;
  at: number;
}

/** Who is recorded as the answerer (PIP-185). */
export const FAST_ANSWERER = "fast lane";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The one option the recommendation names, or null: none matches, or it is unclear which. */
export function recommended(q: Question): Question["options"][number] | null {
  const rec = norm(q.recommendation);
  if (!rec) return null;
  const exact = q.options.filter((o) => norm(o.option) === rec);
  if (exact.length === 1) return exact[0] as Question["options"][number];
  const named = q.options.filter((o) => norm(o.option) !== "" && rec.includes(norm(o.option)));
  return named.length === 1 ? (named[0] as Question["options"][number]) : null;
}

/** The line added to the Question comment. */
export const answeredLine = (option: string) => `Answered automatically with the recommendation: ${option}`;

/**
 * The automatic answer for mission `m`, or null when the owner decides: the intent is not fast or its mark is
 * not confirmed (FAST-9), the wait is not a question, it asks for access or for a test, it has no recommendation
 * that matches an option, or the option is not a plain "carry on".
 */
export async function fastAnswer(
  cx: Pick<Ctx, "db" | "github" | "store" | "repo" | "log" | "clock">,
  m: Mission,
  intent: Intent | null,
): Promise<Outcome | null> {
  if (m.stage !== "blocked" || m.waiting !== "answer the question") return null;
  if (!intent || intent.fast !== true || !fastConfirmed(cx.db, intent.id)) return null;
  const d = dataOf(m) as PipeData & { question?: Question; fastAnswers?: FastAnswer[] };
  const q = d.question;
  if (!q || d.accessAsk || d.testAsk) return null;
  const option = recommended(q);
  if (!option || (option.do && option.do !== "continue")) return null;
  const line = answeredLine(option.option);
  const body = `${questionMd(q, d.brief ?? "")}\n\n${line}`;
  const pr = currentPr(cx as Ctx, m, cx.repo(m));
  try {
    if (pr) {
      await upsertStageComment(cx.github, pr.github, pr.n, "Question", m.continued + 1, body, {
        agent: agentOf("Question", m.stage),
        intent: m.intent,
      });
    } else await cx.store.update(m.intent, "question", (e) => e.setSection("Towercab", body));
  } catch (e) {
    cx.log(`${m.intent}: couldn't note the automatic answer: ${(e as Error).message}`);
  }
  cx.db.run(
    "INSERT OR IGNORE INTO outbox (key, mission, text, created, kind, intent) VALUES (?, NULL, ?, ?, 'info', ?)",
    `fast-answer:${m.id}:${m.continued}`,
    `Fast lane · ${m.intent}\n${q.question.trim()}\nAnswered with the recommendation: ${option.option}`,
    cx.clock.now(),
    m.intent,
  );
  return {
    event: "answered",
    text: option.option,
    counted: true,
    data: {
      answer: option.option,
      answeredBy: FAST_ANSWERER,
      // FAST-10: the page lists each automatic answer.
      fastAnswers: [
        ...(d.fastAnswers ?? []),
        { question: q.question.trim(), answer: option.option, at: cx.clock.now() },
      ],
    },
  };
}
