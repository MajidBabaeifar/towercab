// What a webhook says and where it may say it (LOOP-147..149): the body template, the URL rules and the
// minimal text. Pure, so the config loader can check a webhook before anything is sent.

/** LOOP-148: the body when `template` is not set. */
export const DEFAULT_TEMPLATE = '{"text": "{text}"}';

const PLACEHOLDERS = ["{text}", "{link}"] as const;

/** The value as it sits between the quotes of a JSON string. */
function escaped(v: string): string {
  return JSON.stringify(v).slice(1, -1);
}

/**
 * LOOP-148: `{text}` and `{link}` inside a JSON string of `template` are replaced, JSON-escaped. Any other
 * text stays as written. With `strict`, a placeholder outside a string is reported (as a reason).
 */
function walk(template: string, values: { text: string; link: string }, strict: boolean): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < template.length; ) {
    const c = template[i]!;
    const hit = PLACEHOLDERS.find((p) => template.startsWith(p, i));
    if (hit) {
      if (!inString) {
        if (strict) throw new Error(`has ${hit} outside a JSON string`);
        out += hit;
      } else {
        out += escaped(hit === "{text}" ? values.text : values.link);
      }
      i += hit.length;
      continue;
    }
    if (inString && c === "\\") {
      out += template.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"') inString = !inString;
    out += c;
    i++;
  }
  return out;
}

/** The request body for one message. */
export function renderTemplate(template: string, text: string, link: string): string {
  return walk(template, { text, link }, false);
}

/** LOOP-148: why `template` can't be used, or null. It must be JSON once both placeholders are filled. */
export function templateProblem(template: string): string | null {
  try {
    const sample = walk(template, { text: 'a "quoted"\nline', link: "http://localhost:7311/" }, true);
    JSON.parse(sample);
    return null;
  } catch (e) {
    const why = (e as Error).message;
    return why.startsWith("has ") ? why : "is not valid JSON once {text} and {link} are filled in";
  }
}

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** LOOP-147: a host as written that is on the owner's own machine or network. No name is looked up. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h.endsWith(".local")) return true;
  const m = IPV4.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** LOOP-147: why `url` may not be posted to, or null. The reason never holds the URL. */
export function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not an https url";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:")
    return isLocalHost(u.hostname) ? null : "http is only allowed for local addresses";
  return "not an https url";
}

/** LOOP-149: the text of a `minimal` message: how many things wait, and the local page. */
export function minimalText(waiting: number, link: string | null): string {
  const tail = link ? `: ${link}` : "";
  if (waiting <= 0) return `Towercab needs a look${tail}`;
  return `${waiting} ${waiting === 1 ? "thing waits" : "things wait"} for you in Towercab${tail}`;
}
