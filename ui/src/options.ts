// UI-164: which options send at one click. An option that asks the owner to do something first
// ("Delete the branch on GitHub, then reply here") only fills the reply box.

/** True when the option's text asks for something to be done before the reply. */
export function asksFirst(option: string): boolean {
  return /,\s*then\s+(reply|answer|tell)\b/i.test(option);
}
