/** Sony VID/PIDs: gamepad_id_list.cc:153–158, gamepad_id_list.h:114–118 and gamepad_standard_mappings_win.cc:548–557. */
export function identifyPlayStation(id: string) {
  const product = /\bVendor:\s*054c\s+Product:\s*([\da-f]{4})\b/i.exec(id)?.[1]?.toLowerCase()
  switch (product) {
    case '05c4':
    case '09cc':
    case '0ba0': return 'DualShock 4'
    case '0ce6': return 'DualSense'
    case '0df2': return 'DualSense Edge'
    default: return null
  }
}

type PlayStation = NonNullable<ReturnType<typeof identifyPlayStation>>

// Chromium gamepad_standard_mappings.h:84–89 (canonical axes).
export const PLAYSTATION_AXES = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'] as const

// Chromium gamepad_standard_mappings.h:54–72 (buttons 0–16) and :99–110 (touchpad 17).
// Sony assignments: gamepad_standard_mappings_win.cc:50–70 and :80–101.
export function playStationButtons(controller: PlayStation) {
  return [
    'Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2',
    controller === 'DualShock 4' ? 'Share' : 'Create', 'Options', 'L3', 'R3',
    'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'PS', 'Touchpad',
  ] as const
}
