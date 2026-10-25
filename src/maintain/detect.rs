//! Western Electric detection (MNT-3): pure code over a band's points, no model.

use super::bands::{Side, Tier};

/// The newest points judged.
pub const RECENT: usize = 8;

/// Points before them the mean and σ need.
pub const MIN_BASELINE: usize = 14;

/// σ at most this × max(1, |mean|) is 0: a flat baseline's rounding (0.9 summed 174 times
/// isn't exact), never a spread.
pub const FLAT: f64 = 1e-9;

/// A band out of control at its newest point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Verdict {
    pub tier: Tier,
    /// The newest point: (unix s, value).
    pub point: (f64, f64),
    pub mean: f64,
    pub sigma: f64,
}

/// Mean and sample σ (n − 1) of `values`; fewer than two → `None`.
pub fn stats(values: &[f64]) -> Option<(f64, f64)> {
    let n = values.len();
    if n < 2 {
        return None;
    }
    let mean = values.iter().sum::<f64>() / n as f64;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1) as f64;
    Some((mean, var.sqrt()))
}

/// The baseline of `points` (oldest first): mean and σ of all but the newest [`RECENT`];
/// fewer than [`MIN_BASELINE`] of them or σ = 0 (≤ [`FLAT`] · max(1, |mean|)) → `None`.
pub fn baseline(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    if points.len() < RECENT + MIN_BASELINE {
        return None;
    }
    let before: Vec<f64> = points[..points.len() - RECENT]
        .iter()
        .map(|p| p.1)
        .collect();
    stats(&before).filter(|(m, s)| m.is_finite() && s.is_finite() && *s > FLAT * m.abs().max(1.0))
}

/// A shift from the mean (`v − mean`) is beyond `k`σ on `side`: strictly more than `k`·σ
/// and at least `min_shift` (absolute units) on that side.
pub fn beyond(shift: f64, sigma: f64, k: f64, min_shift: f64, side: Side) -> bool {
    let out = |dir: f64| shift * dir > k * sigma && shift * dir >= min_shift;
    match side {
        Side::High => out(1.0),
        Side::Low => out(-1.0),
        Side::Both => out(1.0) || out(-1.0),
    }
}

/// The rules on one side (`High` or `Low`) over the recent shifts from the mean (oldest
/// first).
fn tier_on(shifts: &[f64], sigma: f64, min_shift: f64, side: Side) -> Option<Tier> {
    let out = |s: f64, k: f64| beyond(s, sigma, k, min_shift, side);
    let count = |k: f64, last: usize| {
        shifts[shifts.len().saturating_sub(last)..]
            .iter()
            .filter(|s| out(**s, k))
            .count()
    };
    if shifts.last().is_some_and(|s| out(*s, 3.0)) {
        return Some(Tier::Three);
    }
    if count(2.0, 3) >= 2 {
        return Some(Tier::Two);
    }
    if count(1.0, 5) >= 4 || (shifts.len() >= RECENT && count(0.0, RECENT) == RECENT) {
        return Some(Tier::One);
    }
    None
}

/// MNT-3 over `points` (oldest first): the newest [`RECENT`] judged against the [`baseline`];
/// on `side`: the newest beyond 3σ → `3sigma`; 2 of the last 3 beyond 2σ → `2sigma`; 4 of the
/// last 5 beyond 1σ, or the last 8 on one side of the mean → `1sigma`; the highest tier only.
/// A point counts only when it is also `min_shift` or more from the mean ([`beyond`]).
pub fn detect(points: &[(f64, f64)], side: Side, min_shift: f64) -> Option<Verdict> {
    let (mean, sigma) = baseline(points)?;
    let recent = &points[points.len() - RECENT..];
    let shifts: Vec<f64> = recent.iter().map(|p| p.1 - mean).collect();
    let sides = match side {
        Side::Both => vec![Side::High, Side::Low],
        one => vec![one],
    };
    let tier = sides
        .iter()
        .filter_map(|s| tier_on(&shifts, sigma, min_shift, *s))
        .max()?;
    Some(Verdict {
        tier,
        point: *recent.last()?,
        mean,
        sigma,
    })
}
