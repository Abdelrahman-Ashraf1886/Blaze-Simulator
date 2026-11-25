//! Mean wind, one discrete gust and optional Dryden turbulence in world coordinates.
//!
//! Frame and direction: documentation/plans/phase-6-flight-environment.md:103-106.
//! MIL-F-8785C §§3.7.3.2 and 3.7.1.3 supply the logarithmic profile and the
//! cosine gust (plan:129-137). The height limits come from MathWorks, with
//! the plan's hold below 3 ft. Integrating mean-air-relative speed after the
//! start is the plan's convention (plan:139-143).

use crate::turbulence::{DrydenState, Parameters};
use rapier3d_f64::math::Vector;
use serde::Deserialize;
use serde_json::Value;
use std::f64::consts::PI;
use std::fmt;

// database/reference/physics.v1.json:1393-1398,1409-1411.
pub(crate) const METRES_PER_FOOT: f64 = 0.3048;
const CATEGORY_C_M: f64 = 0.15 * METRES_PER_FOOT;
const OTHER_PHASES_M: f64 = 2.0 * METRES_PER_FOOT;
const MIN_SHEAR_HEIGHT_M: f64 = 3.0 * METRES_PER_FOOT;
const REFERENCE_HEIGHT_M: f64 = 20.0 * METRES_PER_FOOT;
pub(crate) const MAX_SHEAR_HEIGHT_M: f64 = 1000.0 * METRES_PER_FOOT;

// JSON integers exactly representable throughout the JavaScript IPC path.
const MAX_SAFE_SEED: u64 = (1_u64 << f64::MANTISSA_DIGITS) - 1;

/// Validated wind configuration. The mean and gust share a direction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Wind {
    direction: Vector,
    mean: Option<Mean>,
    gust: Option<Gust>,
    turbulence: Option<(u64, f64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Mean {
    Constant { speed_mps: f64 },
    Shear { speed_at_20_ft_mps: f64, roughness: Roughness },
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Roughness {
    CategoryC {},
    OtherPhases {},
    Custom { length_m: f64 },
}

impl Roughness {
    fn metres(self) -> f64 {
        match self {
            Self::CategoryC {} => CATEGORY_C_M,
            Self::OtherPhases {} => OTHER_PHASES_M,
            Self::Custom { length_m } => length_m,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gust {
    amplitude_mps: f64,
    length_m: f64,
    start_s: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Turbulence {
    Dryden { seed: u64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindInput {
    from_deg: f64,
    mean: Value,
    gust: Value,
    turbulence: Option<Value>,
}

/// A schema, numeric input, or calculation error.
#[derive(Debug)]
pub enum WindError {
    Json(serde_json::Error),
    ExpectedObject(&'static str),
    InvalidNumber { field: &'static str, value: f64, requirement: &'static str },
    ShearHeightAboveLimit(f64),
    TurbulenceSeed,
    TurbulenceNeedsMean,
    Overflow(&'static str),
}

impl fmt::Display for WindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "invalid wind JSON: {error}"),
            Self::ExpectedObject(field) => write!(f, "{field} must be an object"),
            Self::InvalidNumber { field, value, requirement } => {
                write!(f, "{field} must be {requirement} (got {value})")
            }
            Self::ShearHeightAboveLimit(height) => {
                write!(f, "shear height {height} m exceeds 1000 ft ({MAX_SHEAR_HEIGHT_M} m)")
            }
            Self::TurbulenceSeed => write!(f, "turbulence.seed must be a nonnegative JSON safe integer"),
            Self::TurbulenceNeedsMean => write!(f, "Dryden turbulence requires a positive mean wind speed"),
            Self::Overflow(quantity) => write!(f, "{quantity} is outside the finite numeric range"),
        }
    }
}

impl std::error::Error for WindError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

fn number(field: &'static str, value: f64, allowed: bool, requirement: &'static str) -> Result<(), WindError> {
    if value.is_finite() && allowed {
        Ok(())
    } else {
        Err(WindError::InvalidNumber { field, value, requirement })
    }
}

fn object<T: serde::de::DeserializeOwned>(value: Value, field: &'static str) -> Result<T, WindError> {
    if !value.is_object() {
        return Err(WindError::ExpectedObject(field));
    }
    serde_json::from_value(value).map_err(WindError::Json)
}

impl Wind {
    /// The explicit calm state, also used when there is no wind configuration.
    pub const fn calm() -> Self {
        Self { direction: Vector::ZERO, mean: None, gust: None, turbulence: None }
    }

    /// Accepts null for calm, or an object with `fromDeg`, `mean`, and `gust`.
    /// Each component can be explicitly null. Objects refuse unknown fields.
    ///
    /// Mean: `{"kind":"constant","speedMps":…}` or
    /// `{"kind":"shear","speedAt20FtMps":…,"roughness":{"kind":"categoryC"}}`.
    /// Other roughness choices are `{"kind":"otherPhases"}` and
    /// `{"kind":"custom","lengthM":…}`. A custom length must be positive and below
    /// 3 ft, the lowest height evaluated: at h < z0 the logarithm is negative, so
    /// the profile would blow backwards near the ground.
    /// Gust: `{"amplitudeMps":…,"lengthM":…,"startS":…}`, with time since simulation start.
    /// Optional turbulence: `{"kind":"dryden","seed":…}` or null. Dryden
    /// requires a positive constant or 20 ft mean speed and an explicit seed.
    pub fn from_json(value: &Value) -> Result<Self, WindError> {
        if value.is_null() {
            return Ok(Self::calm());
        }
        let input: WindInput = object(value.clone(), "wind")?;
        if input.mean.get("roughness").is_some_and(|value| !value.is_object()) {
            return Err(WindError::ExpectedObject("mean.roughness"));
        }
        let mean = if input.mean.is_null() { None } else { Some(object(input.mean, "mean")?) };
        let gust: Option<Gust> = if input.gust.is_null() { None } else { Some(object(input.gust, "gust")?) };
        number("fromDeg", input.from_deg, true, "finite")?;
        match mean {
            Some(Mean::Constant { speed_mps }) => {
                number("mean.speedMps", speed_mps, speed_mps >= 0.0, "finite and nonnegative")?;
            }
            Some(Mean::Shear { speed_at_20_ft_mps, roughness }) => {
                number("mean.speedAt20FtMps", speed_at_20_ft_mps, speed_at_20_ft_mps >= 0.0, "finite and nonnegative")?;
                let z0 = roughness.metres();
                number("mean.roughness.lengthM", z0, z0 > 0.0 && z0 < MIN_SHEAR_HEIGHT_M, "finite, positive, and below 3 ft")?;
            }
            None => {}
        }
        if let Some(gust) = gust {
            number("gust.amplitudeMps", gust.amplitude_mps, gust.amplitude_mps >= 0.0, "finite and nonnegative")?;
            number("gust.lengthM", gust.length_m, gust.length_m > 0.0, "finite and positive")?;
            number("gust.startS", gust.start_s, gust.start_s >= 0.0, "finite and nonnegative")?;
        }
        let turbulence = match input.turbulence {
            None => None,
            Some(value) => {
                let Turbulence::Dryden { seed } = object(value, "turbulence")?;
                if seed > MAX_SAFE_SEED {
                    return Err(WindError::TurbulenceSeed);
                }
                let w20 = match mean {
                    Some(Mean::Constant { speed_mps }) => speed_mps,
                    Some(Mean::Shear { speed_at_20_ft_mps, .. }) => speed_at_20_ft_mps,
                    None => return Err(WindError::TurbulenceNeedsMean),
                };
                if w20 == 0.0 {
                    return Err(WindError::TurbulenceNeedsMean);
                }
                Some((seed, w20))
            }
        };
        let (sin, cos) = (input.from_deg % 360.0).to_radians().sin_cos();
        Ok(Self { direction: Vector::new(-cos, sin, 0.0), mean, gust, turbulence })
    }

    /// Initial gust state at simulation time zero, if a gust is configured.
    pub fn gust_state(&self) -> Option<GustState> {
        self.gust.map(|gust| GustState { time_until_start_s: gust.start_s.max(0.0), distance_m: 0.0 })
    }

    pub(crate) fn turbulence_state(&self) -> Option<DrydenState> {
        self.turbulence.map(|(seed, _)| DrydenState::new(seed))
    }

    pub(crate) fn turbulence_parameters(&self, height_m: f64) -> Option<Parameters> {
        self.turbulence
            .filter(|_| height_m.is_finite())
            .map(|(_, w20)| Parameters::at_height(height_m, w20))
    }

    pub(crate) fn turbulence_velocity(&self, state: DrydenState, parameters: Parameters) -> Vector {
        let [u, v, w] = state.velocity(parameters);
        let (x, y) = (self.direction.x, self.direction.y);
        Vector::new(x * u - y * v, y * u + x * v, w)
    }

    /// Mean world velocity in m/s, for computing airspeed before the gust.
    pub fn mean_velocity(&self, height_agl_m: f64) -> Result<Vector, WindError> {
        self.world_velocity(self.mean_speed(height_agl_m)?)
    }

    /// Mean plus gust, in world m/s. Negative gust distance gives zero gust.
    /// Finite negative heights use the same 3 ft hold as heights just above ground.
    pub fn velocity(&self, height_agl_m: f64, gust_distance_m: f64) -> Result<Vector, WindError> {
        number("gust distance", gust_distance_m, true, "finite")?;
        let gust_speed = self.gust.map_or(0.0, |gust| gust.speed(gust_distance_m));
        self.world_velocity(self.mean_speed(height_agl_m)? + gust_speed)
    }

    fn mean_speed(&self, height_agl_m: f64) -> Result<f64, WindError> {
        number("height above ground", height_agl_m, true, "finite")?;
        match self.mean {
            None => Ok(0.0),
            Some(Mean::Constant { speed_mps }) => Ok(speed_mps),
            Some(Mean::Shear { speed_at_20_ft_mps, roughness }) => {
                if height_agl_m > MAX_SHEAR_HEIGHT_M {
                    return Err(WindError::ShearHeightAboveLimit(height_agl_m));
                }
                // The same metre-to-foot factor cancels in each logarithm's ratio.
                let height = height_agl_m.max(MIN_SHEAR_HEIGHT_M);
                let z0 = roughness.metres();
                Ok(speed_at_20_ft_mps * (log_ratio(height, z0) / log_ratio(REFERENCE_HEIGHT_M, z0)))
            }
        }
    }

    fn world_velocity(&self, speed_mps: f64) -> Result<Vector, WindError> {
        if !speed_mps.is_finite() {
            return Err(WindError::Overflow("wind speed"));
        }
        if speed_mps == 0.0 {
            return Ok(Vector::ZERO);
        }
        Ok(Vector::new(self.direction.x * speed_mps, self.direction.y * speed_mps, 0.0))
    }
}

fn log_ratio(height: f64, z0: f64) -> f64 {
    // log1p preserves precision near z0 and the difference of logs handles
    // very small custom roughness without overflowing the ratio.
    if (0.5 * height..=2.0 * height).contains(&z0) {
        ((height - z0) / z0).ln_1p()
    } else {
        height.ln() - z0.ln()
    }
}

impl Gust {
    fn speed(self, distance_m: f64) -> f64 {
        if distance_m <= 0.0 {
            return 0.0;
        }
        if distance_m >= self.length_m {
            return self.amplitude_mps;
        }
        // (1 - cos(theta)) / 2 = sin²(theta / 2), including near the start.
        let sine = (0.5 * PI * (distance_m / self.length_m)).sin();
        self.amplitude_mps * (sine * sine)
    }
}

/// Mutable distance integral for one gust. The start is measured from time zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GustState {
    time_until_start_s: f64,
    distance_m: f64,
}

impl GustState {
    /// Distance travelled through the mean air after the gust start, in metres.
    pub fn distance_m(&self) -> f64 {
        self.distance_m
    }

    /// Integrates the supplied speed |v - w_mean| (m/s), held over this step.
    /// A step crossing the start integrates only its part after the start.
    /// On error the state is unchanged.
    pub fn advance(&mut self, airspeed_mps: f64, dt_s: f64) -> Result<(), WindError> {
        number("mean-relative airspeed", airspeed_mps, airspeed_mps >= 0.0, "finite and nonnegative")?;
        number("step duration", dt_s, dt_s >= 0.0, "finite and nonnegative")?;
        let active_s = (dt_s - self.time_until_start_s).max(0.0);
        let distance_m = self.distance_m + airspeed_mps * active_s;
        if !distance_m.is_finite() {
            return Err(WindError::Overflow("gust distance"));
        }
        self.time_until_start_s = (self.time_until_start_s - dt_s).max(0.0);
        self.distance_m = distance_m;
        Ok(())
    }

    /// Float bits, following flight.rs:393-395. Includes the countdown because
    /// it affects future steps even when the current distance is zero.
    pub fn hash_words(&self) -> [u64; 2] {
        [self.time_until_start_s.to_bits(), self.distance_m.to_bits()]
    }
}

#[cfg(test)]
mod tests;
