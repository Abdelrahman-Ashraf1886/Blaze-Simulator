# PX4-Autopilot v1.13.3 notice

Upstream source: https://github.com/PX4/PX4-Autopilot/tree/v1.13.3

Blaze UAV incorporates code and parameter data from PX4-Autopilot.
The application files below give upstream line locators in their comments or in the cited reference table.
The upstream paths are relative to the tagged PX4 repository. An asterisk marks a file absent from the supplied source snapshot.
Copyright statements below come from the available upstream headers. The absent files still need header verification.
The local copies of `src/lib/matrix/matrix/Vector.hpp`, `src/lib/mixer_module/params.c`
and `src/modules/flight_mode_manager/tasks/FlightTask/FlightTask.cpp` have no licence header.

## Application files and upstream sources

- `database/reference/physics.v1.json`
  - `src/lib/mixer_module/motor_params.c` *
  - `src/lib/mixer_module/params.c`
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/land_detector/MulticopterLandDetector.h`
  - `src/modules/land_detector/land_detector_params_mc.c`
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_hover_thrust_estimator/hover_thrust_estimator_params.c`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/mc_rate_control/mc_rate_control_params.c` *
  - `src/modules/navigator/mission_params.c`
  - `src/modules/navigator/navigator_params.c`
  - `src/modules/navigator/rtl_params.c`
  - `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `electron/main/engine/protocol.ts` (citation lines 209, 274)
  - `src/lib/mixer_module/motor_params.c` *
  - `src/lib/mixer_module/params.c`
  - `src/modules/ekf2/ekf2_params.c`
- `simulation-engine/engine-core/src/auto_modes.rs` (citation lines 2?3, 6, 17, 19, 125, 267, 278, 308, 311, 338, 375, 435, 460, 470, 518, 553, 578, 590)
  - `src/lib/mathlib/math/TrajMath.hpp`
  - `src/lib/motion_planning/PositionSmoothing.cpp`
  - `src/lib/motion_planning/TrajectoryConstraints.hpp`
  - `src/modules/flight_mode_manager/tasks/Auto/FlightTaskAuto.cpp`
  - `src/modules/flight_mode_manager/tasks/FlightTask/FlightTask.cpp`
  - `src/modules/land_detector/land_detector_params_mc.c`
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/navigator/mission_block.cpp`
  - `src/modules/navigator/mission_params.c`
  - `src/modules/navigator/navigator_params.c`
  - `src/modules/navigator/rtl.cpp`
  - `src/modules/navigator/rtl_params.c`
- `simulation-engine/engine-core/src/auto_modes/tests.rs` (citation lines 55)
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/navigator/mission_params.c`
  - `src/modules/navigator/navigator_params.c`
  - `src/modules/navigator/rtl_params.c`
- `simulation-engine/engine-core/src/controller.rs` (citation lines 4?6, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 345, 419, 422, 566, 569, 630, 651)
  - `src/lib/mixer_module/params.c`
  - `src/modules/control_allocator/ControlAllocation/ControlAllocationPseudoInverse.cpp` *
  - `src/modules/control_allocator/ControlAllocation/ControlAllocationSequentialDesaturation.cpp` *
  - `src/modules/mc_att_control/AttitudeControl/AttitudeControl.cpp` *
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
  - `src/modules/mc_rate_control/RateControl/RateControl.cpp`
  - `src/modules/mc_rate_control/mc_rate_control_params.c` *
- `simulation-engine/engine-core/src/controller/tests.rs`
  - `src/lib/mixer_module/params.c`
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/mc_rate_control/mc_rate_control_params.c` *
- `simulation-engine/engine-core/src/flight/tests.rs` (citation lines 594?595)
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/flight_loop.rs` (citation lines 19, 22, 132, 138, 350, 360, 364, 413, 454, 465, 484, 507, 552, 554, 571, 583, 600)
  - `src/lib/mathlib/math/Limits.hpp`
  - `src/modules/ekf2/EKF2.cpp`
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/flight_mode_manager/tasks/ManualAltitude/FlightTaskManualAltitude.cpp`
  - `src/modules/land_detector/LandDetector.cpp`
  - `src/modules/land_detector/MulticopterLandDetector.cpp`
  - `src/modules/mc_hover_thrust_estimator/MulticopterHoverThrustEstimator.cpp`
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
  - `src/modules/mc_pos_control/Takeoff/Takeoff.cpp`
  - `src/modules/mc_rate_control/MulticopterRateControl.cpp`
- `simulation-engine/engine-core/src/flight_loop/tests.rs` (citation lines 264)
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/mc_pos_control/Takeoff/Takeoff.cpp`
  - `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `simulation-engine/engine-core/src/flight_modes.rs` (citation lines 60, 109, 116, 126, 131, 140, 192, 228, 243, 308?309, 313?314, 330, 358, 396?397, 401, 420, 442, 474, 482, 530, 543, 559, 573?574, 590, 608, 651)
  - `src/lib/mathlib/math/Functions.hpp`
  - `src/lib/mathlib/math/filter/AlphaFilter.hpp`
  - `src/lib/matrix/matrix/Vector.hpp`
  - `src/lib/motion_planning/ManualVelocitySmoothingZ.cpp`
  - `src/lib/motion_planning/ManualVelocitySmoothingZ.hpp`
  - `src/lib/motion_planning/VelocitySmoothing.cpp`
  - `src/lib/slew_rate/SlewRate.hpp`
  - `src/lib/slew_rate/SlewRateYaw.hpp`
  - `src/modules/flight_mode_manager/tasks/FlightTask/FlightTask.cpp`
  - `src/modules/flight_mode_manager/tasks/ManualAcceleration/FlightTaskManualAcceleration.cpp`
  - `src/modules/flight_mode_manager/tasks/ManualAltitude/FlightTaskManualAltitude.cpp`
  - `src/modules/flight_mode_manager/tasks/ManualAltitudeSmoothVel/FlightTaskManualAltitudeSmoothVel.cpp`
  - `src/modules/flight_mode_manager/tasks/ManualPosition/FlightTaskManualPosition.cpp`
  - `src/modules/flight_mode_manager/tasks/Utility/StickAccelerationXY.cpp`
  - `src/modules/flight_mode_manager/tasks/Utility/StickYaw.cpp`
  - `src/modules/flight_mode_manager/tasks/Utility/Sticks.cpp`
  - `src/modules/mc_att_control/mc_att_control_main.cpp`
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_rate_control/MulticopterRateControl.cpp`
- `simulation-engine/engine-core/src/flight_modes/tests.rs` (citation lines 117, 221, 260)
  - `src/lib/motion_planning/ManualVelocitySmoothingZ.cpp`
  - `src/modules/flight_mode_manager/tasks/Utility/StickAccelerationXY.cpp`
  - `src/modules/mc_att_control/mc_att_control_main.cpp`
- `simulation-engine/engine-core/src/gyro_filters.rs` (citation lines 44, 65, 96, 113, 140, 172)
  - `src/lib/mathlib/math/filter/AlphaFilter.hpp`
  - `src/lib/mathlib/math/filter/LowPassFilter2p.hpp`
  - `src/lib/mathlib/math/filter/NotchFilter.hpp`
  - `src/modules/sensors/vehicle_angular_velocity/VehicleAngularVelocity.cpp`
- `simulation-engine/engine-core/src/gyro_filters/tests.rs`
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `simulation-engine/engine-core/src/hover_thrust.rs` (citation lines 33, 47, 49, 51, 53, 55, 57, 59, 116, 118, 139, 145?146, 163, 179, 186, 200, 212, 216, 224, 240, 264, 279)
  - `src/modules/mc_hover_thrust_estimator/MulticopterHoverThrustEstimator.cpp`
  - `src/modules/mc_hover_thrust_estimator/MulticopterHoverThrustEstimator.hpp`
  - `src/modules/mc_hover_thrust_estimator/hover_thrust_estimator_params.c`
  - `src/modules/mc_hover_thrust_estimator/zero_order_hover_thrust_ekf.cpp`
  - `src/modules/mc_hover_thrust_estimator/zero_order_hover_thrust_ekf.hpp`
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/hover_thrust/tests.rs`
  - `src/modules/mc_hover_thrust_estimator/hover_thrust_estimator_params.c`
- `simulation-engine/engine-core/src/land_detector.rs` (citation lines 4?5, 12, 35, 40, 53, 72, 153, 178, 182, 190, 193, 197, 206, 217, 261)
  - `src/modules/land_detector/LandDetector.cpp`
  - `src/modules/land_detector/LandDetector.h`
  - `src/modules/land_detector/MulticopterLandDetector.cpp`
  - `src/modules/land_detector/MulticopterLandDetector.h`
  - `src/modules/land_detector/land_detector_params_mc.c`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/land_detector/tests.rs` (citation lines 61)
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/position_control.rs` (citation lines 34, 39, 43, 45, 48?52, 92, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 142, 144, 146, 148, 150, 152, 154, 156, 158, 160, 162, 164, 166, 168, 170, 172, 174, 176, 178, 186, 188, 190, 192, 194, 196, 198, 200, 202, 204, 400?403, 492, 508, 516, 563, 573, 623, 741, 751, 756)
  - `src/lib/controllib/BlockDerivative.cpp` *
  - `src/lib/controllib/BlockDerivative.hpp` *
  - `src/lib/controllib/BlockLowPass.cpp` *
  - `src/lib/controllib/BlockLowPass.hpp` *
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/PositionControl/ControlMath.cpp` *
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
  - `src/modules/mc_pos_control/PositionControl/PositionControl.hpp` *
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/position_control/tests.rs` (citation lines 351, 380, 559, 649, 710, 766, 837)
  - `src/lib/controllib/BlockDerivative.cpp` *
  - `src/lib/controllib/BlockLowPass.cpp` *
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/PositionControl/ControlMath.cpp` *
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
- `simulation-engine/engine-core/src/sensors.rs` (citation lines 18)
  - `src/modules/sensors/vehicle_angular_velocity/VehicleAngularVelocity.cpp`
- `simulation-engine/engine-core/src/takeoff.rs` (citation lines 6, 23, 34, 87, 93, 95, 135, 179)
  - `src/lib/hysteresis/hysteresis.cpp`
  - `src/lib/hysteresis/hysteresis.h`
  - `src/modules/mc_pos_control/MulticopterPositionControl.cpp`
  - `src/modules/mc_pos_control/PositionControl/PositionControl.cpp`
  - `src/modules/mc_pos_control/Takeoff/Takeoff.cpp`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
- `simulation-engine/engine-core/src/takeoff/tests.rs` (citation lines 14)
  - `src/modules/land_detector/land_detector_params_mc.c`
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/mc_rate_control/mc_rate_control_params.c` *
  - `src/modules/navigator/mission_params.c`
- `simulation-engine/engine-core/src/thrust_model.rs` (citation lines 3, 6, 9, 13, 111)
  - `src/lib/mixer_module/functions.hpp` *
  - `src/lib/mixer_module/motor_params.c` *
- `src/domain/controller-params.ts` (citation lines 5–8, 167–169, 221–225)
  - `src/lib/mixer_module/motor_params.c` *
  - `src/lib/mixer_module/params.c`
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/mc_att_control/mc_att_control_params.c` *
  - `src/modules/mc_hover_thrust_estimator/hover_thrust_estimator_params.c`
  - `src/modules/mc_pos_control/mc_pos_control_params.c`
  - `src/modules/mc_rate_control/mc_rate_control_params.c` *
  - `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `src/domain/flight-metrics.ts` (citation lines 106, 154)
  - `src/modules/flight_mode_manager/tasks/ManualPosition/FlightTaskManualPosition.cpp`
  - `src/modules/land_detector/LandDetector.cpp`
- `src/domain/input-mapping.ts` (citation lines 40)
  - `src/modules/rc_update/rc_update.cpp`
- `src/domain/sensors.ts` (citation lines 13, 103?104, 205)
  - `src/lib/mathlib/math/filter/AlphaFilter.hpp`
  - `src/lib/mathlib/math/filter/LowPassFilter2p.hpp`
  - `src/lib/mathlib/math/filter/NotchFilter.hpp`
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `src/domain/thrust-curve.ts` (citation lines 23?24)
  - `src/lib/mixer_module/motor_params.c` *
- `src/features/flight/sensors/settings.ts` (citation lines 2, 20–22)
  - `src/modules/ekf2/ekf2_params.c`
  - `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`
  - `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c`
- `src/features/flight/sticks.ts` (citation lines 9)
  - `src/modules/flight_mode_manager/tasks/Utility/Sticks.cpp`
- `src/features/telemetry/report/ReportPage.tsx` (citation lines 23)
  - `src/lib/mixer_module/params.c`
- `src/three/frame-geometry.ts` (citation lines 9)
  - `src/lib/mixer/MultirotorMixer/geometries/hex_x.toml` *
  - `src/lib/mixer/MultirotorMixer/geometries/octa_x.toml` *
  - `src/lib/mixer/MultirotorMixer/geometries/quad_x.toml` *

## BSD-3-Clause notices from the available PX4 source headers

`src/modules/ekf2/ekf2_params.c` (headers at the start of each file).

```text
Copyright (c) 2015-2016 Estimation and Control Library (ECL). All rights reserved.
```

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
3. Neither the name ECL nor the names of its contributors may be
   used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

`src/lib/mathlib/math/filter/LowPassFilter2p.hpp` (headers at the start of each file).

```text
Copyright (C) 2012-2021 PX4 Development Team. All rights reserved.
```

`src/lib/mathlib/math/filter/NotchFilter.hpp` (headers at the start of each file).

```text
Copyright (C) 2019-2021 PX4 Development Team. All rights reserved.
```

`src/lib/mathlib/math/Limits.hpp` (headers at the start of each file).

```text
Copyright (c) 2013 PX4 Development Team. All rights reserved.
```

`src/modules/land_detector/LandDetector.cpp`, `src/modules/land_detector/MulticopterLandDetector.cpp`, `src/modules/land_detector/MulticopterLandDetector.h`, `src/modules/mc_pos_control/mc_pos_control_params.c` (headers at the start of each file).

```text
Copyright (c) 2013-2016 PX4 Development Team. All rights reserved.
```

`src/modules/land_detector/LandDetector.h` (headers at the start of each file).

```text
Copyright (c) 2013-2017 PX4 Development Team. All rights reserved.
```

`src/modules/mc_att_control/mc_att_control_main.cpp` (headers at the start of each file).

```text
Copyright (c) 2013-2018 PX4 Development Team. All rights reserved.
```

`src/modules/mc_rate_control/MulticopterRateControl.cpp` (headers at the start of each file).

```text
Copyright (c) 2013-2019 PX4 Development Team. All rights reserved.
```

`src/modules/mc_pos_control/MulticopterPositionControl.cpp`, `src/modules/navigator/rtl.cpp` (headers at the start of each file).

```text
Copyright (c) 2013-2020 PX4 Development Team. All rights reserved.
```

`src/modules/navigator/mission_block.cpp` (headers at the start of each file).

```text
Copyright (c) 2014 PX4 Development Team. All rights reserved.
```

`src/modules/land_detector/land_detector_params_mc.c`, `src/modules/navigator/mission_params.c` (headers at the start of each file).

```text
Copyright (c) 2014-2016 PX4 Development Team. All rights reserved.
```

`src/modules/ekf2/EKF2.cpp` (headers at the start of each file).

```text
Copyright (c) 2015-2022 PX4 Development Team. All rights reserved.
```

`src/lib/hysteresis/hysteresis.cpp`, `src/lib/hysteresis/hysteresis.h` (headers at the start of each file).

```text
Copyright (c) 2016-2019 PX4 Development Team. All rights reserved.
```

`src/modules/rc_update/rc_update.cpp` (headers at the start of each file).

```text
Copyright (c) 2016-2021 PX4 Development Team. All rights reserved.
```

`src/lib/mathlib/math/Functions.hpp` (headers at the start of each file).

```text
Copyright (c) 2017 PX4 Development Team. All rights reserved.
```

`src/modules/mc_pos_control/PositionControl/PositionControl.cpp` (headers at the start of each file).

```text
Copyright (c) 2018 - 2019 PX4 Development Team. All rights reserved.
```

`src/modules/flight_mode_manager/tasks/Auto/FlightTaskAuto.cpp`, `src/modules/flight_mode_manager/tasks/ManualAltitude/FlightTaskManualAltitude.cpp`, `src/modules/flight_mode_manager/tasks/ManualPosition/FlightTaskManualPosition.cpp` (headers at the start of each file).

```text
Copyright (c) 2018 PX4 Development Team. All rights reserved.
```

`src/lib/motion_planning/VelocitySmoothing.cpp` (headers at the start of each file).

```text
Copyright (c) 2018-2019 PX4 Development Team. All rights reserved.
```

`src/lib/mathlib/math/TrajMath.hpp`, `src/lib/motion_planning/ManualVelocitySmoothingZ.cpp`, `src/lib/motion_planning/ManualVelocitySmoothingZ.hpp`, `src/lib/motion_planning/TrajectoryConstraints.hpp`, `src/modules/flight_mode_manager/tasks/ManualAltitudeSmoothVel/FlightTaskManualAltitudeSmoothVel.cpp`, `src/modules/mc_pos_control/Takeoff/Takeoff.cpp`, `src/modules/mc_rate_control/RateControl/RateControl.cpp` (headers at the start of each file).

```text
Copyright (c) 2019 PX4 Development Team. All rights reserved.
```

`src/lib/mathlib/math/filter/AlphaFilter.hpp` (headers at the start of each file).

```text
Copyright (c) 2019-2020 PX4 Development Team. All rights reserved.
```

`src/modules/sensors/vehicle_angular_velocity/VehicleAngularVelocity.cpp` (headers at the start of each file).

```text
Copyright (c) 2019-2022 PX4 Development Team. All rights reserved.
```

`src/lib/slew_rate/SlewRate.hpp`, `src/lib/slew_rate/SlewRateYaw.hpp`, `src/modules/flight_mode_manager/tasks/ManualAcceleration/FlightTaskManualAcceleration.cpp`, `src/modules/flight_mode_manager/tasks/Utility/StickYaw.cpp`, `src/modules/flight_mode_manager/tasks/Utility/Sticks.cpp`, `src/modules/sensors/vehicle_acceleration/imu_accel_parameters.c`, `src/modules/sensors/vehicle_angular_velocity/imu_gyro_parameters.c` (headers at the start of each file).

```text
Copyright (c) 2020 PX4 Development Team. All rights reserved.
```

`src/modules/mc_hover_thrust_estimator/MulticopterHoverThrustEstimator.cpp`, `src/modules/mc_hover_thrust_estimator/MulticopterHoverThrustEstimator.hpp`, `src/modules/mc_hover_thrust_estimator/hover_thrust_estimator_params.c`, `src/modules/mc_hover_thrust_estimator/zero_order_hover_thrust_ekf.cpp`, `src/modules/mc_hover_thrust_estimator/zero_order_hover_thrust_ekf.hpp` (headers at the start of each file).

```text
Copyright (c) 2020-2022 PX4 Development Team. All rights reserved.
```

`src/lib/motion_planning/PositionSmoothing.cpp` (headers at the start of each file).

```text
Copyright (c) 2021 PX4 Development Team. All rights reserved.
```

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
3. Neither the name PX4 nor the names of its contributors may be
   used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

`src/modules/navigator/navigator_params.c`, `src/modules/navigator/rtl_params.c` (headers at the start of each file).

```text
Copyright (c) 2014-2016 PX4 Development Team. All rights reserved.
```

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
3. Neither the name PX4 nor the names of its contributors may be
   used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
AS IS AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

`src/modules/flight_mode_manager/tasks/Utility/StickAccelerationXY.cpp` (headers at the start of each file).

```text
Copyright (c) 2020 PX4 Development Team. All rights reserved.
```

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.
3. Neither the name PX4 nor the names of its contributors may be
   used to endorse or promote products derived from this software
   without spec{fic prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```
