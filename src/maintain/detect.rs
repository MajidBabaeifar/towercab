//! Western Electric detection (MNT-3): pure code over a band's points, no model.

use super::bands::{Side, Tier};

/// The newest points judged.
pub const RECENT: usize = 8;

/// Points before them the mean and σ need.
pub const MIN_BASELINE: usize = 14;

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
/// fewer than [`MIN_BASELINE`] of them or σ = 0 → `None`.
pub fn baseline(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    if points.len() < RECENT + MIN_BASELINE {
        return None;
    }
    let before: Vec<f64> = points[..points.len() - RECENT]
        .iter()
        .map(|p| p.1)
        .collect();
    stats(&before).filter(|(m, s)| m.is_finite() && s.is_finite() && *s > 0.0)
}

/// The rules on one side (`dir` = +1 high, −1 low) over the recent z-scores (oldest first).
fn tier_on(z: &[f64], dir: f64) -> Option<Tier> {
    let beyond = |k: f64, last: usize| {
        z[z.len().saturating_sub(last)..]
            .iter()
            .filter(|v| *v * dir > k)
            .count()
    };
    if z.last().is_some_and(|v| v * dir > 3.0) {
        return Some(Tier::Three);
    }
    if beyond(2.0, 3) >= 2 {
        return Some(Tier::Two);
    }
    if beyond(1.0, 5) >= 4 || (z.len() >= RECENT && beyond(0.0, RECENT) == RECENT) {
        return Some(Tier::One);
    }
    None
}

/// MNT-3 over `points` (oldest first): the newest [`RECENT`] judged against the [`baseline`];
/// on `side`: the newest beyond 3σ → `3sigma`; 2 of the last 3 beyond 2σ → `2sigma`; 4 of the
/// last 5 beyond 1σ, or the last 8 on one side of the mean → `1sigma`; the highest tier only.
pub fn detect(points: &[(f64, f64)], side: Side) -> Option<Verdict> {
    let (mean, sigma) = baseline(points)?;
    let recent = &points[points.len() - RECENT..];
    let z: Vec<f64> = recent.iter().map(|p| (p.1 - mean) / sigma).collect();
    let dirs: &[f64] = match side {
        Side::High => &[1.0],
        Side::Low => &[-1.0],
        Side::Both => &[1.0, -1.0],
    };
    let tier = dirs.iter().filter_map(|d| tier_on(&z, *d)).max()?;
    Some(Verdict {
        tier,
        point: *recent.last()?,
        mean,
        sigma,
    })
}
