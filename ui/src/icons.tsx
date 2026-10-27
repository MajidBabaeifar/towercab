// The page's icons (UI-55, UI-56): inline SVG, 24-unit grid, stroked in currentColor.

import type { ComponentChildren, JSX } from "preact";
import type { StateKey } from "../../src/ui/view.ts";

interface IconProps {
  size?: number;
  class?: string;
  title?: string;
}

function svg(children: ComponentChildren) {
  return ({ size = 16, class: cls, title }: IconProps): JSX.Element => (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative unless a title is given, then it has one
    <svg
      class={`icon${cls ? ` ${cls}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Bell = svg(
  <>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </>,
);
export const Spinner = svg(
  <>
    <circle cx="12" cy="12" r="9" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </>,
);
export const Hourglass = svg(
  <>
    <path d="M6 2h12M6 22h12" />
    <path d="M7 2v3.5a5 5 0 0 0 2.2 4.1L12 12l2.8-2.4A5 5 0 0 0 17 5.5V2" />
    <path d="M7 22v-3.5a5 5 0 0 1 2.2-4.1L12 12l2.8 2.4a5 5 0 0 1 2.2 4.1V22" />
  </>,
);
export const ListIcon = svg(
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3" />
  </>,
);
export const Snowflake = svg(
  <>
    <path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7" />
    <path d="m9 4 3 2 3-2M9 20l3-2 3 2" />
  </>,
);
export const Pause = svg(
  <>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </>,
);
export const Play = svg(
  <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />,
);
export const Alert = svg(
  <>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </>,
);
export const ArrowRight = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8M13 9l3 3-3 3" />
  </>,
);
export const Moon = svg(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />);
export const Check = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </>,
);
export const XCircle = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m15 9-6 6M9 9l6 6" />
  </>,
);
export const External = svg(
  <>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </>,
);
export const More = svg(
  <>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </>,
);
export const ChevronLeft = svg(<path d="m15 18-6-6 6-6" />);
export const ChevronDown = svg(<path d="m6 9 6 6 6-6" />);
export const PullRequest = svg(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M6 8.5v7M13 6h3a2 2 0 0 1 2 2v7.5" />
    <path d="m15 3-2 3 2 3" />
  </>,
);
export const Merge = svg(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <path d="M6 8.5v7M6 8.5c0 2 2 3.5 4.5 3.5h5" />
  </>,
);
export const Reply = svg(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
);
export const Restart = svg(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </>,
);
export const Trash = svg(
  <>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </>,
);
export const FileText = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </>,
);
export const Coin = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M14.8 9.2A3 3 0 0 0 12 8c-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-2.8-1.2M12 6.5v11" />
  </>,
);
export const Clock = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const Sparkle = svg(
  <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
);
export const Dot = svg(<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />);
export const Log = svg(<path d="M4 6h16M4 12h10M4 18h13" />);

/** Towercab's mark: a control tower's beacon. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect class="logo-bg" width="32" height="32" rx="9" />
      <path class="logo-line" d="M11 25h10M13.5 25l1-9h3l1 9" />
      <rect class="logo-fill" x="11.5" y="11" width="9" height="5" rx="1.5" />
      <path class="logo-line logo-beam" d="M9 8.5a9 9 0 0 1 14 0" />
    </svg>
  );
}

const STATE_ICONS: Record<StateKey, (p: IconProps) => JSX.Element> = {
  needs: Bell,
  working: Spinner,
  ci: Hourglass,
  queued: ListIcon,
  cooling: Snowflake,
  paused: Pause,
  stalled: Alert,
  upnext: ArrowRight,
  parked: Moon,
  done: Check,
  dropped: XCircle,
};

export function StateIcon({ state, size = 14 }: { state: StateKey; size?: number }) {
  const I = STATE_ICONS[state];
  return <I size={size} class={state === "working" ? "spin" : undefined} />;
}
