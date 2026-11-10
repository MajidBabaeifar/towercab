// Network grants (PIP-164): a host name or `*.<name>` with at least two labels, and how a grant matches a host.

import { isIP } from "node:net";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `grant` may not be a network grant (PIP-164), or null when it is one. */
export function invalidDomain(grant: string): string | null {
  const d = grant.trim().toLowerCase();
  if (!d) return "it is empty";
  if (d === "*") return "it would open the whole internet";
  if (d.includes("://") || d.includes("/")) return "it is a URL, not a domain name";
  if (isIP(d) || isIP(d.replace(/^\[|\]$/g, ""))) return "it is an IP address, not a domain name";
  if (d.includes(":")) return "it names a port, not just a domain";
  const name = d.startsWith("*.") ? d.slice(2) : d;
  const labels = name.split(".");
  if (name.includes("*")) return "a wildcard is only allowed as a leading `*.`";
  if (labels.length < 2) return "it is a bare top-level name, not a domain";
  if (/^\d+$/.test(labels[labels.length - 1]!)) return "it is an IP address, not a domain name";
  if (!labels.every((l) => LABEL.test(l))) return "it is not a valid host name";
  return null;
}

/** True when `host` is covered by `grant` (`*.d` matches subdomains of `d`, not `d` itself). */
export function domainMatches(grant: string, host: string): boolean {
  const g = grant.trim().toLowerCase();
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (g.startsWith("*.")) return h.endsWith(g.slice(1)) && h.length > g.length - 1;
  return h === g;
}

/** The grants that pass `invalidDomain`, and the others with their reasons. */
export function splitDomains(grants: string[]): {
  valid: string[];
  invalid: { domain: string; why: string }[];
} {
  const valid: string[] = [];
  const invalid: { domain: string; why: string }[] = [];
  for (const g of grants) {
    const why = invalidDomain(g);
    if (why) invalid.push({ domain: g, why });
    else valid.push(g);
  }
  return { valid, invalid };
}
