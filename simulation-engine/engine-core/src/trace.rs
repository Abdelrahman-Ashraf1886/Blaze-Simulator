//! Samples are stamped at the start of the physics step whose commands they
//! contain. The recorder keeps steps 0, n, 2n, …, including on early termination.
use crate::{closed_loop::SaturationDiagnostic, vehicle::Quat};
use serde::{ser::Serializer, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Signal {
    Rate { setpoint_radps: f64, measured_radps: f64 },
    Attitude { setpoint_rad: f64, measured_rad: f64 },
    Position { setpoint_m: f64, measured_m: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub time_s: f64,
    pub signal: Signal,
    pub commanded_body_rates_radps: [f64; 3],
    pub commanded_attitude_xyzw: Option<Quat>,
    pub saturation: SaturationDiagnostic,
}

#[derive(Debug)]
pub struct Trace {
    decimation_steps: u64,
    total_steps: u64,
    motor_count: usize,
    samples: Vec<Sample>,
    motor_commands: Vec<f64>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSample<'a> {
    #[serde(flatten)]
    pub sample: &'a Sample,
    pub motor_commands_01: &'a [f64],
}

impl Trace {
    pub(crate) fn new(total_steps: u64, decimation_steps: u64, motor_count: usize) -> Result<Self, String> {
        if decimation_steps == 0 {
            return Err("decimationSteps must be a positive whole number".into());
        }
        if motor_count == 0 {
            return Err("a trace needs at least one motor".into());
        }
        let capacity = usize::try_from(total_steps.div_ceil(decimation_steps))
            .map_err(|_| "trace sample count is too large")?;
        let command_capacity = capacity.checked_mul(motor_count)
            .ok_or("trace motor command count is too large")?;
        let mut samples = Vec::new();
        let mut motor_commands = Vec::new();
        samples.try_reserve_exact(capacity).map_err(|e| format!("trace samples: {e}"))?;
        motor_commands.try_reserve_exact(command_capacity).map_err(|e| format!("trace motor commands: {e}"))?;
        Ok(Self { decimation_steps, total_steps, motor_count, samples, motor_commands })
    }

    pub(crate) fn wants(&self, step: u64) -> bool {
        step < self.total_steps && step.is_multiple_of(self.decimation_steps)
    }

    pub(crate) fn record(&mut self, step: u64, sample: Sample, motor_commands: &[f64]) {
        if self.wants(step) {
            assert_eq!(step / self.decimation_steps, self.samples.len() as u64);
            assert_eq!(motor_commands.len(), self.motor_count);
            self.samples.push(sample);
            self.motor_commands.extend_from_slice(motor_commands);
        }
    }

    pub fn samples(&self) -> impl ExactSizeIterator<Item = TraceSample<'_>> {
        self.samples.iter().zip(self.motor_commands.chunks_exact(self.motor_count))
            .map(|(sample, motor_commands_01)| TraceSample { sample, motor_commands_01 })
    }
}

impl Serialize for Trace {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        struct Samples<'a>(&'a Trace);
        impl Serialize for Samples<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_seq(self.0.samples())
            }
        }

        let mut trace = serializer.serialize_struct("Trace", 2)?;
        trace.serialize_field("decimationSteps", &self.decimation_steps)?;
        trace.serialize_field("samples", &Samples(self))?;
        trace.end()
    }
}

#[cfg(test)]
mod tests;
