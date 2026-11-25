//! Validate the wire model with field paths shared by both entry points.
use engine_core::sensors::{
    BarometerConfig, GpsConfig, ImuConfig, SensorConfig, Sensors, ISA_MAX_ALTITUDE_M, ISA_MIN_ALTITUDE_M,
};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

// Largest integer represented unambiguously by the JSON consumer (protocol.ts).
const MAX_SAFE_INTEGER: f64 = ((1_u64 << f64::MANTISSA_DIGITS) - 1) as f64;

pub(crate) fn parse_sensors(value: Option<Value>, path: &str) -> Result<Option<Sensors>, String> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(None) };
    let mut fields = Fields::new(value, path)?;
    let seed = fields.checked::<f64>("seed", "must be a signed safe integer", |n| {
        n.abs() <= MAX_SAFE_INTEGER && n.fract() == 0.0
    })? as i64;
    let gyro = fields.group("gyro", imu)?;
    let accelerometer = fields.group("accelerometer", |fields| {
        let mount = fields.field("mountPositionM")?;
        Ok((imu(fields)?, mount))
    })?;
    let barometer = fields.group("barometer", |fields| {
        // atmosphere.ts:72–93 uses standard pressure at altitude even when
        // actual temperature is supplied for density.
        fields.checked::<Option<f64>>("referenceTemperatureK", "must be positive or null", |t| {
            t.is_none_or(|n| n > 0.0)
        })?;
        Ok(BarometerConfig {
            reference_altitude_m: fields.checked::<f64>("referenceAltitudeM", "must be inside the ISA troposphere range", |n| {
                (ISA_MIN_ALTITUDE_M..=ISA_MAX_ALTITUDE_M).contains(&n)
            })?,
            sigma_pa: fields.sigma("sigmaPa")?,
            bias_pa: fields.field::<Option<f64>>("biasPa")?.unwrap_or(0.0),
            period_steps: fields.period()?,
            delay_steps: fields.delay()?,
        })
    })?;
    let gps = fields.group("gps", |fields| Ok(GpsConfig {
        position_sigma_horizontal_m: fields.sigma("positionSigmaHorizontalM")?,
        position_sigma_vertical_m: fields.sigma("positionSigmaVerticalM")?,
        velocity_sigma_mps: fields.sigma("velocitySigmaMps")?,
        period_steps: fields.period()?,
        delay_steps: fields.delay()?,
    }))?;
    fields.finish()?;
    Ok(Sensors::new(seed, SensorConfig { gyro, accelerometer, barometer, gps }))
}

fn imu(fields: &mut Fields) -> Result<ImuConfig, String> {
    Ok(ImuConfig {
        noise_sigma: fields.sigma("noiseSigma")?,
        vibration_sigma: fields.sigma("vibrationSigma")?,
        bias: fields.field::<Option<[f64; 3]>>("bias")?.unwrap_or([0.0; 3]),
        random_walk: fields.sigma("randomWalk")?,
        delay_steps: fields.delay()?,
        range: fields.checked::<Option<f64>>("range", "must be positive or null", |v| v.is_none_or(|n| n > 0.0))?,
    })
}

struct Fields {
    path: String,
    remaining: Map<String, Value>,
}

impl Fields {
    fn new(value: Value, path: &str) -> Result<Self, String> {
        let Value::Object(remaining) = value else { return Err(format!("{path} must be an object")) };
        Ok(Self { path: path.into(), remaining })
    }

    fn field<T: DeserializeOwned>(&mut self, key: &str) -> Result<T, String> {
        let value = self.remaining.remove(key).ok_or_else(|| format!("{}.{} is required", self.path, key))?;
        serde_json::from_value(value).map_err(|e| format!("{}.{}: {e}", self.path, key))
    }

    fn checked<T: DeserializeOwned>(&mut self, key: &str, rule: &str, valid: impl FnOnce(&T) -> bool) -> Result<T, String> {
        let value = self.field(key)?;
        if !valid(&value) {
            return Err(format!("{}.{} {rule}", self.path, key));
        }
        Ok(value)
    }

    fn group<T>(&mut self, key: &str, parse: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<Option<T>, String> {
        let Some(value) = self.field::<Option<Value>>(key)? else { return Ok(None) };
        let mut fields = Self::new(value, &format!("{}.{key}", self.path))?;
        let config = parse(&mut fields)?;
        fields.finish()?;
        Ok(Some(config))
    }

    fn finish(self) -> Result<(), String> {
        if let Some(key) = self.remaining.keys().next() {
            return Err(format!("{}.{} is unknown", self.path, key));
        }
        Ok(())
    }

    fn sigma(&mut self, key: &str) -> Result<f64, String> {
        let value = self.checked::<Option<f64>>(key, "must be nonnegative or null", |v| v.is_none_or(|n| n >= 0.0))?;
        Ok(value.unwrap_or(0.0))
    }

    fn delay(&mut self) -> Result<u64, String> {
        let value = self.checked::<Option<f64>>("delaySteps", "must be a nonnegative whole step count (1 ms per step) or null", |v| {
            v.is_none_or(|n| (0.0..=MAX_SAFE_INTEGER).contains(&n) && n.fract() == 0.0)
        })?;
        Ok(value.unwrap_or(0.0) as u64)
    }

    fn period(&mut self) -> Result<u64, String> {
        let value = self.checked::<f64>("periodSteps", "must be a positive whole step count (1 ms per step)", |n| {
            (1.0..=MAX_SAFE_INTEGER).contains(n) && n.fract() == 0.0
        })?;
        Ok(value as u64)
    }
}
