//! Maintain (MNT, specs/maintain.md): bands on Towercab's own process metrics, judged in code
//! (Western Electric) once per completed period.

pub mod bands;
pub mod detect;

/// A period counts as completed this long after its end (Prometheus takes samples up to
/// 10 min old).
pub const GRACE: f64 = 600.0;
