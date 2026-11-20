# Maintain

**Status:** Removed: its intent 261026-2204-2 is closed · **Prefix:** MNT

## Purpose

v1 watched Towercab's own metrics against 30-day bands and turned a breach into a diagnosed intent.
It never fired, and v2 leaves it out. Its requirements MNT-1 to MNT-8 are removed; v1's text is on
branch `rust`.

## Requirements

### MNT-1 to MNT-8 · Bands, detection, diagnosis, triage, lessons

Removed: not built; its intent 261026-2204-2 is closed and the observer replaces it (OBV-1).

## Out of scope

Everything; see the closed intent.

## Decisions

- Not ported: it needs weeks of metrics to mean anything, and v2 drops the Grafana
  export it read from.
