# Maintain

**Status:** Removed: parked as intent 261026-2204-2 · **Prefix:** MNT

## Purpose

v1 watched Towercab's own metrics against 30-day bands and turned a breach into a diagnosed intent.
It never fired, and v2 leaves it out. Its requirements MNT-1 to MNT-8 are removed; v1's text is on
branch `rust`.

## Requirements

### MNT-1 to MNT-8 · Bands, detection, diagnosis, triage, lessons

Removed: parked as intent 261026-2204-2.

## Out of scope

Everything; see the parked intent.

## Decisions

- Parked rather than ported: it needs weeks of metrics to mean anything, and v2 drops the Grafana
  export it read from.
