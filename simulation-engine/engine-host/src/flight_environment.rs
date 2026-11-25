use engine_core::{flight::Flight, wind::{Wind, WindError}};
use serde_json::Value;

/// The named refusal is also used for explicit null, which is a wind request.
pub(crate) fn propulsion_required(wind: Option<&Value>, ground_effect: Option<&Value>, prefix: &str) -> Option<String> {
    let fields = [("wind", wind), ("groundEffect", ground_effect)]
        .into_iter()
        .filter_map(|(name, input)| input.map(|_| format!("{prefix}{name}")))
        .collect::<Vec<_>>();
    (!fields.is_empty()).then(|| format!("{} requires the propulsion definition (vehicle.load with propulsion)", fields.join(", ")))
}

/// Wind uses world Z-up. Bearing is the direction it comes from, clockwise in
/// degrees from world +X. Speeds are m/s, lengths are metres (shear height is
/// AGL, with speed referenced at 20 ft), and gust start is seconds from run start.
/// Ground-effect radii are in metres, in vehicle motor order, at the body-frame hubs.
pub(crate) fn configure(
    flight: &mut Flight,
    wind: Option<&Value>,
    ground_effect: Option<&Value>,
    prefix: &str,
) -> Result<(), String> {
    if let Some(wind) = wind.filter(|value| !value.is_null()) {
        let wind = Wind::from_json(wind).map_err(|error| match &error {
            WindError::ExpectedObject(field) | WindError::InvalidNumber { field, .. } if *field != "wind" => {
                format!("{prefix}wind.{error}")
            }
            WindError::TurbulenceSeed => format!("{prefix}wind.{error}"),
            _ => format!("{prefix}wind: {error}"),
        })?;
        flight.set_wind(wind);
    }
    if let Some(ground_effect) = ground_effect {
        let path = format!("{prefix}groundEffect");
        let entries = ground_effect.as_array().ok_or_else(|| format!("{path}: must be an array of propeller radii in metres"))?;
        let radii = entries.iter().enumerate().map(|(i, entry)| {
            entry.as_f64().filter(|radius| radius.is_finite() && *radius > 0.0)
                .ok_or_else(|| format!("{path}[{i}]: radius must be finite and positive"))
        }).collect::<Result<Vec<_>, _>>()?;
        flight.set_ground_effect(&radii).map_err(|error| format!("{path}: {error}"))?;
    }
    Ok(())
}
