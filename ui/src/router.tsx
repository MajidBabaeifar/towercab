// A tiny router on location.pathname (UI-55): `/`, `/i/<id>`, `/board`, `/focus`, `/repos` (and `/queue`, its old name), `/activity`.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

const EVENT = "towercab:navigate";

function here(): string {
  return location.pathname + location.search;
}

export function usePath(): string {
  const [p, setP] = useState(here());
  useEffect(() => {
    const on = () => setP(here());
    addEventListener("popstate", on);
    addEventListener(EVENT, on);
    return () => {
      removeEventListener("popstate", on);
      removeEventListener(EVENT, on);
    };
  }, []);
  return p;
}

/** Go to `href`; `replace` keeps history short (filters). */
export function navigate(href: string, o: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (o.replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  dispatchEvent(new Event(EVENT));
  if (!o.keepScroll) scrollTo(0, 0);
}

type LinkProps = Omit<JSX.HTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ComponentChildren;
};

export function Link({ href, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (typeof onClick === "function") onClick(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
