//! PX4 v1.13.3 static gyro filters at one sample per 1 ms plant step (phase 7 D7).
//! PX4 filters the raw-rate FIFO and limits publication to IMU_GYRO_RATEMAX
//! (800 Hz for multicopters, rc.mc_defaults:13–16). This loop runs at 1 kHz.

use crate::sim::DEFAULT_DT_S;
use std::f32::consts::PI;

const SAMPLE_HZ: f32 = (1.0 / DEFAULT_DT_S) as f32;

#[derive(Clone, Copy, Debug)]
pub struct GyroFilterConfig {
    pub gyro_cutoff_hz: f32,
    pub dgyro_cutoff_hz: f32,
    pub notch0: Option<NotchConfig>,
    pub notch1: Option<NotchConfig>,
}

#[derive(Clone, Copy, Debug)]
pub struct NotchConfig {
    pub frequency_hz: f32,
    pub bandwidth_hz: f32,
}

/// Rate input and derivative used by one controller tick. Before a delayed
/// gyro sample arrives, the rate is held at the initial true rate with zero D.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateFeedback {
    pub rate_radps: [f64; 3],
    pub acceleration_radps2: [f64; 3],
    pub from_gyro: bool,
}

fn valid_cutoff(hz: f32) -> bool {
    hz.is_finite() && hz > 0.0 && hz < SAMPLE_HZ / 2.0
}

struct LowPass {
    b: [f32; 3],
    a: [f32; 2],
    delay: [f32; 2],
}

impl LowPass {
    // LowPassFilter2p.hpp:61–90,146–160 (including Nyquist bypass and the 0.1% floor).
    fn new(hz: f32) -> Self {
        let mut filter = Self { b: [1.0, 0.0, 0.0], a: [0.0; 2], delay: [0.0; 2] };
        if valid_cutoff(hz) {
            let fr = SAMPLE_HZ / hz.max(SAMPLE_HZ * 0.001);
            let ohm = (PI / fr).tan();
            let c = 1.0 + 2.0 * (PI / 4.0).cos() * ohm + ohm * ohm;
            let b0 = ohm * ohm / c;
            let b = [b0, 2.0 * b0, b0];
            let a = [
                2.0 * (ohm * ohm - 1.0) / c,
                (1.0 - 2.0 * (PI / 4.0).cos() * ohm + ohm * ohm) / c,
            ];
            if b.into_iter().chain(a).all(f32::is_finite) {
                filter.b = b;
                filter.a = a;
            }
        }
        filter
    }

    // LowPassFilter2p.hpp:98–108 and 127–143.
    fn apply(&mut self, sample: f32) -> f32 {
        let [d1, d2] = self.delay;
        let d0 = sample - d1 * self.a[0] - d2 * self.a[1];
        let output = d0 * self.b[0] + d1 * self.b[1] + d2 * self.b[2];
        self.delay = [d0, d1];
        output
    }

    fn reset(&mut self, sample: f32) {
        let input = if sample.is_finite() { sample } else { 0.0 };
        let dc = 1.0 + self.a[0] + self.a[1];
        let delay = if dc.abs() > f32::EPSILON { input / dc } else { input };
        self.delay = [if delay.is_finite() { delay } else { input }; 2];
        self.apply(input);
    }

    fn hash(&self, word: &mut impl FnMut(u64)) {
        hash_values(self.b.into_iter().chain(self.a).chain(self.delay), word);
    }
}

struct Notch {
    b: [f32; 3],
    a: [f32; 2],
    input: [f32; 2],
    output: [f32; 2],
    initialized: bool,
}

impl Notch {
    // NotchFilter.hpp:217–229,267–285. Runtime retuning is outside this path.
    fn new(config: NotchConfig) -> Option<Self> {
        if !valid_cutoff(config.frequency_hz) || !config.bandwidth_hz.is_finite() || config.bandwidth_hz <= 0.0 {
            return None;
        }
        let floor = SAMPLE_HZ * 0.001;
        let alpha = (PI * config.bandwidth_hz.max(floor) / SAMPLE_HZ).tan();
        let beta = -(2.0 * PI * config.frequency_hz.max(floor) / SAMPLE_HZ).cos();
        let b0 = 1.0 / (alpha + 1.0);
        let b1 = 2.0 * beta * b0;
        let a2 = (1.0 - alpha) * b0;
        [b0, b1, a2].into_iter().all(f32::is_finite).then_some(Self {
            b: [b0, b1, b0], a: [b1, a2], input: [0.0; 2], output: [0.0; 2],
            initialized: false,
        })
    }

    // NotchFilter.hpp:78–87,133–147,173–187.
    fn apply(&mut self, sample: f32) -> f32 {
        if !self.initialized {
            let input = if sample.is_finite() { sample } else { 0.0 };
            self.input = [input; 2];
            self.output = [input * (self.b[0] + self.b[1] + self.b[2]) / (1.0 + self.a[0] + self.a[1]); 2];
            self.initialized = true;
        }
        let output = self.b[0] * sample + self.b[1] * self.input[0] + self.b[2] * self.input[1]
            - self.a[0] * self.output[0] - self.a[1] * self.output[1];
        self.input = [sample, self.input[0]];
        self.output = [output, self.output[0]];
        output
    }

    fn hash(&self, word: &mut impl FnMut(u64)) {
        word(u64::from(self.initialized));
        hash_values(self.b.into_iter().chain(self.a).chain(self.input).chain(self.output), word);
    }
}

struct Alpha {
    alpha: f32,
    state: f32,
}

impl Alpha {
    // AlphaFilter.hpp:67–88,102–119; VehicleAngularVelocity.cpp:182–190.
    fn new(hz: f32) -> Self {
        let dt = 1.0 / SAMPLE_HZ;
        let alpha = if valid_cutoff(hz) { dt / (1.0 / (2.0 * PI * hz) + dt) } else { 1.0 };
        Self { alpha, state: 0.0 }
    }

    fn apply(&mut self, sample: f32) -> f32 {
        self.state = (1.0 - self.alpha) * self.state + self.alpha * sample;
        self.state
    }
}

struct Axis {
    notches: [Option<Notch>; 2],
    rate: LowPass,
    acceleration: Alpha,
    previous: Option<f32>,
}

pub(crate) struct GyroFilters([Axis; 3]);

impl GyroFilters {
    pub(crate) fn new(config: GyroFilterConfig) -> Self {
        Self(std::array::from_fn(|_| Axis {
            notches: [config.notch0.and_then(Notch::new), config.notch1.and_then(Notch::new)],
            rate: LowPass::new(config.gyro_cutoff_hz),
            acceleration: Alpha::new(config.dgyro_cutoff_hz),
            previous: None,
        }))
    }

    // VehicleAngularVelocity.cpp:160–190,735–763. Prime the low-pass and
    // difference from the first available sample, with initial acceleration zero.
    // PX4's reset uses the last valid publication, or zero on cold start (:493–526).
    // PX4 subtracts its estimated gyro bias after filtering (:916). The model's
    // entered gyro bias represents what remains after that correction.
    pub(crate) fn apply(&mut self, sample: [f64; 3]) -> RateFeedback {
        let mut rate = [0.0; 3];
        let mut acceleration = [0.0; 3];
        for (i, axis) in self.0.iter_mut().enumerate() {
            let mut value = sample[i] as f32;
            for notch in axis.notches.iter_mut().flatten() {
                value = notch.apply(value);
            }
            if axis.previous.is_none() {
                axis.rate.reset(value);
            }
            let filtered = axis.rate.apply(value);
            let difference = (filtered - axis.previous.replace(filtered).unwrap_or(filtered)) * SAMPLE_HZ;
            rate[i] = f64::from(filtered);
            acceleration[i] = f64::from(axis.acceleration.apply(difference));
        }
        RateFeedback { rate_radps: rate, acceleration_radps2: acceleration, from_gyro: true }
    }

    pub(crate) fn hash(&self, word: &mut impl FnMut(u64)) {
        for axis in &self.0 {
            for notch in &axis.notches {
                word(u64::from(notch.is_some()));
                if let Some(notch) = notch { notch.hash(word); }
            }
            axis.rate.hash(word);
            hash_values([axis.acceleration.alpha, axis.acceleration.state], word);
            word(u64::from(axis.previous.is_some()));
            hash_values(axis.previous, word);
        }
    }
}

fn hash_values(values: impl IntoIterator<Item = f32>, word: &mut impl FnMut(u64)) {
    values.into_iter().for_each(|v| word(u64::from(v.to_bits())));
}

#[cfg(test)]
mod tests;
