//! Recorded sensor models. The host advances them once after each plant step.
use std::collections::VecDeque;

use rapier3d_f64::{math::Vector, na::{ComplexField, Quaternion, UnitQuaternion}};

use crate::{
    math::STANDARD_GRAVITY,
    sim::{SimConfig, SimState},
    turbulence::SplitMix64,
};

#[derive(Clone, Copy)]
pub struct ImuConfig {
    pub noise_sigma: f64,
    pub vibration_sigma: f64,
    pub bias: [f64; 3],
    pub random_walk: f64,
    pub delay_steps: u64,
    pub range: Option<f64>,
}

#[derive(Clone, Copy)]
pub struct BarometerConfig {
    pub reference_altitude_m: f64,
    pub sigma_pa: f64,
    pub bias_pa: f64,
    pub period_steps: u64,
    pub delay_steps: u64,
}

#[derive(Clone, Copy)]
pub struct GpsConfig {
    pub position_sigma_horizontal_m: f64,
    pub position_sigma_vertical_m: f64,
    pub velocity_sigma_mps: f64,
    pub period_steps: u64,
    pub delay_steps: u64,
}

pub type AccelerometerConfig = (ImuConfig, [f64; 3]);

#[derive(Default)]
pub struct SensorConfig {
    pub gyro: Option<ImuConfig>,
    /// Accelerometer config and its mounting point relative to the body origin, FLU.
    pub accelerometer: Option<AccelerometerConfig>,
    pub barometer: Option<BarometerConfig>,
    pub gps: Option<GpsConfig>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImuSample {
    pub value: [f64; 3],
    pub clipped: [bool; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarometerSample {
    pub pressure_pa: f64,
    pub altitude_m: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GpsSample {
    pub position_m: [f64; 3],
    pub velocity_mps: [f64; 3],
}

struct Delay<T> {
    steps: u64,
    pending: VecDeque<(u64, Option<T>)>,
    held: Option<T>,
}

impl<T> Delay<T> {
    fn new(steps: u64) -> Self {
        Self { steps, pending: VecDeque::new(), held: None }
    }

    fn advance(&mut self, step: u64, sample: Option<Option<T>>) {
        if let Some(sample) = sample {
            self.pending.push_back((step, sample));
        }
        if self.pending.front().is_some_and(|(taken, _)| step - taken >= self.steps) {
            self.held = self.pending.pop_front().unwrap().1;
        }
    }

    fn hash(&self, word: &mut impl FnMut(u64), sample: fn(T, &mut dyn FnMut(u64)))
    where T: Copy {
        let reading = |stored: Option<T>, word: &mut dyn FnMut(u64)| {
            word(u64::from(stored.is_some()));
            if let Some(value) = stored {
                sample(value, word);
            }
        };
        word(self.steps);
        reading(self.held, word);
        word(self.pending.len() as u64);
        for &(step, value) in &self.pending {
            word(step);
            reading(value, word);
        }
    }
}

struct Imu {
    config: ImuConfig,
    streams: [SplitMix64; 3],
    walk: [f64; 3],
    delay: Delay<ImuSample>,
}

impl Imu {
    fn new(config: ImuConfig, streams: [SplitMix64; 3]) -> Self {
        Self { config, streams, walk: [0.0; 3], delay: Delay::new(config.delay_steps) }
    }

    fn advance(&mut self, step: u64, truth: [f64; 3], sqrt_dt: f64) {
        let mut sample = ImuSample { value: truth, clipped: [false; 3] };
        for (axis, stream) in self.streams.iter_mut().enumerate() {
            let [white, walk, vibration, ..] = stream.normals();
            // Independent Wiener increments have variance (density² · dt).
            self.walk[axis] += (self.config.random_walk * sqrt_dt) * walk;
            let value = truth[axis] + self.config.bias[axis] + self.walk[axis]
                + self.config.noise_sigma * white + self.config.vibration_sigma * vibration;
            sample.value[axis] = if let Some(range) = self.config.range {
                sample.clipped[axis] = value.abs() > range;
                value.clamp(-range, range)
            } else {
                value
            };
        }
        self.delay.advance(step, Some(Some(sample)));
    }

    fn hash(&self, word: &mut impl FnMut(u64)) {
        let c = self.config;
        floats(word, [c.noise_sigma, c.vibration_sigma, c.random_walk, c.range.unwrap_or(f64::NAN)]);
        floats(word, c.bias);
        floats(word, self.walk);
        self.streams.iter().for_each(|rng| word(rng.0));
        self.delay.hash(word, |s, word| {
            floats(word, s.value);
            s.clipped.into_iter().for_each(|flag| word(u64::from(flag)));
        });
    }
}

struct Barometer {
    config: BarometerConfig,
    stream: SplitMix64,
    delay: Delay<BarometerSample>,
}

struct Gps {
    config: GpsConfig,
    position_streams: [SplitMix64; 3],
    velocity_streams: [SplitMix64; 3],
    delay: Delay<GpsSample>,
}

pub struct Sensors {
    gyro: Option<Imu>,
    accelerometer: Option<(Imu, [f64; 3])>,
    barometer: Option<Barometer>,
    gps: Option<Gps>,
    previous: Option<SimState>,
}

impl Sensors {
    /// Interpret the signed safe-integer seed as a two's complement u64. Use
    /// successive SplitMix64 outputs as stream seeds in fixed slots: gyro XYZ,
    /// accelerometer XYZ, barometer, GPS position XYZ, GPS velocity XYZ.
    /// Reserve slots even for disabled sensors. Every active stream consumes
    /// six uniforms per plant step, including between slow samples.
    pub fn new(seed: i64, config: SensorConfig) -> Option<Self> {
        let SensorConfig { gyro, accelerometer, barometer, gps } = config;
        if gyro.is_none() && accelerometer.is_none() && barometer.is_none() && gps.is_none() {
            return None;
        }
        let mut root = SplitMix64(seed as u64);
        let [gyro_streams, accel_streams] = std::array::from_fn(|_| std::array::from_fn(|_| SplitMix64(root.next())));
        let baro_stream = SplitMix64(root.next());
        let [position_streams, velocity_streams] = std::array::from_fn(|_| std::array::from_fn(|_| SplitMix64(root.next())));
        Some(Self {
            gyro: gyro.map(|config| Imu::new(config, gyro_streams)),
            accelerometer: accelerometer.map(|(config, mount)| (Imu::new(config, accel_streams), mount)),
            barometer: barometer.map(|config| Barometer {
                config, stream: baro_stream, delay: Delay::new(config.delay_steps),
            }),
            gps: gps.map(|config| Gps {
                config, position_streams, velocity_streams, delay: Delay::new(config.delay_steps),
            }),
            previous: None,
        })
    }

    /// Step zero supplies the initial velocities. The first acquisition is
    /// after plant step one, then every periodSteps for the slow sensors.
    pub fn observe(&mut self, state: SimState, sim: SimConfig) {
        let Some(previous) = self.previous.replace(state) else {
            debug_assert_eq!(state.steps, 0);
            return;
        };
        debug_assert_eq!(previous.steps + 1, state.steps);
        let step = state.steps;
        let sqrt_dt = ComplexField::sqrt(sim.dt_s);
        if let Some(gyro) = &mut self.gyro {
            gyro.advance(step, state.angular_velocity_body_radps, sqrt_dt);
        }
        if let Some((accel, mount)) = &mut self.accelerometer {
            accel.advance(step, specific_force(previous, state, *mount, sim), sqrt_dt);
        }
        if let Some(baro) = &mut self.barometer {
            let c = baro.config;
            let [normal, ..] = baro.stream.normals();
            let sample = (step - 1).is_multiple_of(c.period_steps).then(|| {
                isa_pressure(c.reference_altitude_m + state.com_m[2]).map(|pressure| {
                    let pressure_pa = pressure + c.bias_pa + c.sigma_pa * normal;
                    BarometerSample { pressure_pa, altitude_m: isa_altitude(pressure_pa) }
                })
            });
            baro.delay.advance(step, sample);
        }
        if let Some(gps) = &mut self.gps {
            let c = gps.config;
            let mut position_m = state.com_m;
            let mut velocity_mps = state.linear_velocity_mps;
            let position_sigma = [c.position_sigma_horizontal_m, c.position_sigma_horizontal_m, c.position_sigma_vertical_m];
            for axis in 0..3 {
                position_m[axis] += position_sigma[axis] * gps.position_streams[axis].normals()[0];
                velocity_mps[axis] += c.velocity_sigma_mps * gps.velocity_streams[axis].normals()[0];
            }
            let sample = (step - 1).is_multiple_of(c.period_steps).then_some(Some(GpsSample { position_m, velocity_mps }));
            gps.delay.advance(step, sample);
        }
    }

    pub fn gyro(&self) -> Option<ImuSample> {
        self.gyro.as_ref()?.delay.held
    }

    pub fn accelerometer(&self) -> Option<ImuSample> {
        self.accelerometer.as_ref()?.0.delay.held
    }

    pub fn barometer(&self) -> Option<BarometerSample> {
        self.barometer.as_ref()?.delay.held
    }

    pub fn gps(&self) -> Option<GpsSample> {
        self.gps.as_ref()?.delay.held
    }

    /// Continue the plant/controller FNV-1a hash (sim.rs). This also works on
    /// the final hash returned by scenario runners, without hashing queues at
    /// every plant step. Hash config, streams, accumulated walks and samples
    /// still held or in flight. The plant hash already covers the velocities
    /// from the last observed step.
    pub fn extend_hash(&self, mut hash: u64) -> u64 {
        let mut word = |value: u64| {
            for byte in value.to_le_bytes() {
                hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
            }
        };
        word(u64::from(self.gyro.is_some()));
        word(u64::from(self.accelerometer.is_some()));
        word(u64::from(self.barometer.is_some()));
        word(u64::from(self.gps.is_some()));
        if let Some(gyro) = &self.gyro { gyro.hash(&mut word); }
        if let Some((accel, mount)) = &self.accelerometer {
            floats(&mut word, *mount);
            accel.hash(&mut word);
        }
        if let Some(baro) = &self.barometer {
            let c = baro.config;
            floats(&mut word, [c.reference_altitude_m, c.sigma_pa, c.bias_pa]);
            word(c.period_steps);
            word(baro.stream.0);
            baro.delay.hash(&mut word, |s, word| {
                floats(word, [s.pressure_pa, s.altitude_m.unwrap_or(f64::NAN)]);
            });
        }
        if let Some(gps) = &self.gps {
            let c = gps.config;
            floats(&mut word, [c.position_sigma_horizontal_m, c.position_sigma_vertical_m, c.velocity_sigma_mps]);
            word(c.period_steps);
            gps.position_streams.iter().chain(&gps.velocity_streams).for_each(|rng| word(rng.0));
            gps.delay.hash(&mut word, |s, word| {
                floats(word, s.position_m);
                floats(word, s.velocity_mps);
            });
        }
        hash
    }
}

fn floats(word: &mut (impl FnMut(u64) + ?Sized), values: impl IntoIterator<Item = f64>) {
    values.into_iter().for_each(|v| word(v.to_bits()));
}

/// For a rigid mount, p_IMU = p_CoM + Rr where r is fixed in the body.
/// Differentiating Rr once gives ω × Rr. Differentiating again gives the
/// Euler term α × Rr and the centripetal term ω × (ω × Rr).
/// Use step differences of CoM velocity and world angular velocity (including
/// contact impulses), express them in the new body axes, and subtract gravity
/// from the CoM acceleration. The rotating terms are evaluated at the new pose.
fn specific_force(before: SimState, after: SimState, mount: [f64; 3], config: SimConfig) -> [f64; 3] {
    let vec = Vector::from_array;
    let [x, y, z, w] = after.quaternion;
    let attitude = UnitQuaternion::new_unchecked(Quaternion::new(w, x, y, z));
    let offset = vec(mount) - attitude.inverse_transform_vector(&(vec(after.com_m) - vec(after.position_m)));
    let com_accel = (vec(after.linear_velocity_mps) - vec(before.linear_velocity_mps)) / config.dt_s;
    let alpha = (vec(after.angular_velocity_radps) - vec(before.angular_velocity_radps)) / config.dt_s;
    let gravity = Vector::new(0.0, 0.0, -config.gravity_mps2);
    let omega = vec(after.angular_velocity_body_radps);
    (attitude.inverse_transform_vector(&(com_accel - gravity))
        + attitude.inverse_transform_vector(&alpha).cross(&offset)
        + omega.cross(&omega.cross(&offset))).into()
}

// src/domain/atmosphere.ts:41–42,72–93 and database/reference/physics.v1.json:12–104.
// This ISA convention uses actual air temperature for density only. Pressure
// uses the standard temperature at altitude, including on non-standard days.
pub const ISA_MIN_ALTITUDE_M: f64 = -5000.0;
pub const ISA_MAX_ALTITUDE_M: f64 = 11000.0;
const SEA_LEVEL_PRESSURE: f64 = 101325.0;
const SEA_LEVEL_TEMPERATURE: f64 = 288.15;
const LAPSE_RATE: f64 = -6.5 / 1000.0;
const GAS_CONSTANT: f64 = 8314.32 / 1000.0;
const MOLAR_MASS: f64 = 28.9644 / 1000.0;
const EXPONENT: f64 = (STANDARD_GRAVITY * MOLAR_MASS) / (GAS_CONSTANT * LAPSE_RATE);

fn isa_pressure(altitude: f64) -> Option<f64> {
    (ISA_MIN_ALTITUDE_M..=ISA_MAX_ALTITUDE_M).contains(&altitude).then(|| {
        let temperature = SEA_LEVEL_TEMPERATURE + LAPSE_RATE * altitude;
        SEA_LEVEL_PRESSURE * ComplexField::powf(SEA_LEVEL_TEMPERATURE / temperature, EXPONENT)
    })
}

fn isa_altitude(pressure: f64) -> Option<f64> {
    let low = isa_pressure(ISA_MAX_ALTITUDE_M).unwrap();
    let high = isa_pressure(ISA_MIN_ALTITUDE_M).unwrap();
    (low..=high).contains(&pressure).then(|| {
        let temperature = SEA_LEVEL_TEMPERATURE / ComplexField::powf(pressure / SEA_LEVEL_PRESSURE, 1.0 / EXPONENT);
        ((temperature - SEA_LEVEL_TEMPERATURE) / LAPSE_RATE).clamp(ISA_MIN_ALTITUDE_M, ISA_MAX_ALTITUDE_M)
    })
}

#[cfg(test)]
mod tests;
