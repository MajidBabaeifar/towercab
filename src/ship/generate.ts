// SHIP-34: the value of a generated secret, from the system's secure random source.

import { randomBytes, randomInt } from "node:crypto";

export const ALPHABETS = {
  hex: "0123456789abcdef",
  alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  urlsafe: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
} as const;

export type Alphabet = keyof typeof ALPHABETS;

export const DEFAULT_LENGTH = 43;
export const MAX_LENGTH = 256;

/**
 * Nothing set: 32 random bytes as URL-safe base64 without padding (43 characters). Else `length`
 * characters (default 43) of `alphabet` (default `urlsafe`), each drawn without modulo bias.
 */
export function generateSecret(length?: number | null, alphabet?: Alphabet | null): string {
  if (!length && !alphabet) return randomBytes(32).toString("base64url");
  const n = length ?? DEFAULT_LENGTH;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LENGTH) throw new Error(`length is 1 to ${MAX_LENGTH}`);
  const chars = ALPHABETS[alphabet ?? "urlsafe"];
  if (!chars) throw new Error("alphabet is hex, alnum or urlsafe");
  let out = "";
  for (let i = 0; i < n; i++) out += chars[randomInt(chars.length)];
  return out;
}
