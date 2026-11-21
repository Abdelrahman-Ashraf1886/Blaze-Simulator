/**
 * Detailed procedural models for parts, after the visual design of the original
 * Blaze-Simulator workshop (motor bell with vents and windings, bladed propellers,
 * Pixhawk-style case with ports), rebuilt for this Z-up, metre renderer.
 *
 * Each model fills the part's envelope exactly (centred on the origin, Z up), so
 * a linked part still matches its datasheet size; details never stick out of it.
 * Models are decoration: sizes, bounds and checks always use the envelope.
 */
import { useMemo, type ReactNode } from 'react'
import { ExtrudeGeometry, Shape } from 'three'
import type { Vec3 } from './views'

// sRGB hex; three.js materials do not read CSS variables.
const C = {
  metal: '#9aa3ad',
  metalDark: '#5d6670',
  dark: '#262b32',
  darker: '#181c21',
  copper: '#b8743d',
  accent: '#c9692f',
  pcb: '#1f3a2c',
  chip: '#15181c',
  ivory: '#d9d5c7',
  label: '#3d6fa3',
  led: '#5dab8b',
  /** Both blades one colour, light enough to read against the dark viewport. */
  prop: '#9aa4ae',
  propTip: '#c9692f',
}

function Mat({ color, metal = 0.15, rough = 0.6, opacity }: { color: string; metal?: number; rough?: number; opacity?: number }) {
  return (
    <meshStandardMaterial
      color={color}
      metalness={metal}
      roughness={rough}
      transparent={opacity !== undefined}
      opacity={opacity ?? 1}
      depthWrite={opacity === undefined}
    />
  )
}

/** Cylinder along Z (three.js cylinders run along Y). */
function Cyl({ r, h, z = 0, x = 0, y = 0, n = 36, children }: { r: number; h: number; z?: number; x?: number; y?: number; n?: number; children: ReactNode }) {
  return (
    <mesh position={[x, y, z]} rotation-x={Math.PI / 2}>
      <cylinderGeometry args={[r, r, h, n]} />
      {children}
    </mesh>
  )
}

function Box({ size, at = [0, 0, 0], rotZ = 0, children }: { size: Vec3; at?: Vec3; rotZ?: number; children: ReactNode }) {
  return (
    <mesh position={[...at]} rotation-z={rotZ}>
      <boxGeometry args={[...size]} />
      {children}
    </mesh>
  )
}

// ---- Motor ------------------------------------------------------------------------------

/** Outrunner: base flange, visible windings, bell with accent ring and vents, shaft. */
export function MotorModel({ radius: r, height: h }: { radius: number; height: number }) {
  const z0 = -h / 2
  const base = h * 0.14
  const gap = h * 0.12
  const bell = h * 0.56
  const cap = h * 0.08
  const shaft = h - base - gap - bell - cap
  const vents = 10
  return (
    <group>
      <Cyl r={r * 0.97} h={base} z={z0 + base / 2}>
        <Mat color={C.metalDark} metal={0.5} rough={0.45} />
      </Cyl>
      {/* windings seen through the gap between base and bell */}
      <Cyl r={r * 0.82} h={gap} z={z0 + base + gap / 2}>
        <Mat color={C.dark} />
      </Cyl>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2
        return (
          <Cyl key={i} r={r * 0.085} h={gap * 0.9} x={Math.cos(a) * r * 0.84} y={Math.sin(a) * r * 0.84} z={z0 + base + gap / 2} n={10}>
            <Mat color={C.copper} metal={0.6} rough={0.35} />
          </Cyl>
        )
      })}
      <Cyl r={r} h={bell} z={z0 + base + gap + bell / 2}>
        <Mat color={C.metal} metal={0.65} rough={0.35} />
      </Cyl>
      {/* Slightly proud of the bell so the band never z-fights with it. */}
      <Cyl r={r * 1.006} h={bell * 0.12} z={z0 + base + gap + bell * 0.72}>
        <Mat color={C.accent} metal={0.4} rough={0.4} />
      </Cyl>
      <Cyl r={r * 0.94} h={cap} z={z0 + base + gap + bell + cap / 2}>
        <Mat color={C.metalDark} metal={0.5} rough={0.45} />
      </Cyl>
      {Array.from({ length: vents }, (_, i) => {
        const a = (i / vents) * Math.PI * 2
        return (
          <Box key={i} size={[r * 0.3, r * 0.1, cap * 0.3]} at={[Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, z0 + base + gap + bell + cap]} rotZ={a}>
            <Mat color={C.darker} />
          </Box>
        )
      })}
      <Cyl r={Math.min(r * 0.14, r)} h={shaft} z={h / 2 - shaft / 2} n={16}>
        <Mat color={C.metal} metal={0.8} rough={0.25} />
      </Cyl>
    </group>
  )
}

// ---- Propeller -----------------------------------------------------------------------------

/** One blade outline, root at the hub, tip at radius 1; leading edge on +X. */
const BLADE: [number, number][] = [
  [-0.07, 0.1],
  [-0.15, 0.55],
  [-0.1, 0.93],
  [0.02, 1.0],
  [0.12, 0.87],
  [0.13, 0.5],
  [0.06, 0.1],
]

/** Outer part of the blade outline (from 82 % of the radius). */
const BLADE_TIP: [number, number][] = [
  [-0.115, 0.82],
  [-0.1, 0.93],
  [0.02, 1.0],
  [0.12, 0.87],
  [0.125, 0.82],
]

/**
 * Bladed propeller filling the swept disc: blades extruded from an outline, a hub,
 * and a faint disc so the swept area stays visible. `spin` mirrors the blades:
 * seen from above a CCW prop leads with +X.
 */
export function PropellerModel({ radius: R, height: t, blades = 2, spin = 'ccw' }: { radius: number; height: number; blades?: number; spin?: 'cw' | 'ccw' }) {
  const [geometry, tip] = useMemo(() => {
    const extrude = (points: [number, number][], depth: number) => {
      const s = new Shape()
      points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x * R, y * R) : s.lineTo(x * R, y * R)))
      s.closePath()
      const g = new ExtrudeGeometry(s, { depth, bevelEnabled: false })
      g.translate(0, 0, -depth / 2)
      return g
    }
    // The tip is a slightly thicker copy of the outer part of the blade, so it never z-fights.
    return [extrude(BLADE, t * 0.4), extrude(BLADE_TIP, t * 0.44)]
  }, [R, t])
  // A hub about the size of a prop adapter, not the whole motor top.
  const hub = Math.min(R * 0.06, R)
  return (
    <group scale={[spin === 'cw' ? -1 : 1, 1, 1]}>
      {Array.from({ length: blades }, (_, i) => (
        <group key={i} rotation-z={(i / blades) * Math.PI * 2}>
          <mesh geometry={geometry}>
            <Mat color={C.prop} rough={0.45} />
          </mesh>
          {/* Coloured tip, as on real props, so rotation and blade count read at a glance. */}
          <mesh geometry={tip}>
            <Mat color={C.propTip} rough={0.45} />
          </mesh>
        </group>
      ))}
      <Cyl r={hub} h={t} n={24}>
        <Mat color={C.dark} />
      </Cyl>
      <Cyl r={R} h={t * 0.05} n={64}>
        <Mat color={C.metal} opacity={0.08} />
      </Cyl>
    </group>
  )
}

// ---- Boxes: battery, ESC, flight controller, module ------------------------------------------------

export function BatteryModel({ size: [l, w, h] }: { size: Vec3 }) {
  return (
    <group>
      <Box size={[l, w, h]}>
        <Mat color={C.dark} rough={0.7} />
      </Box>
      {/* wrap label and end caps */}
      <Box size={[l * 0.55, w * 1.002, h * 1.002]}>
        <Mat color={C.label} rough={0.55} />
      </Box>
      <Box size={[l * 0.18, w * 1.003, h * 0.22]} at={[0, 0, h * 0.2]}>
        <Mat color={C.ivory} rough={0.6} />
      </Box>
      {[-1, 1].map((s) => (
        <Box key={s} size={[l * 0.04, w * 1.004, h * 1.004]} at={[s * (l / 2 - l * 0.02), 0, 0]}>
          <Mat color={C.darker} />
        </Box>
      ))}
    </group>
  )
}

export function EscModel({ size: [l, w, h] }: { size: Vec3 }) {
  const board = h * 0.35
  const z0 = -h / 2
  return (
    <group>
      <Box size={[l, w, board]} at={[0, 0, z0 + board / 2]}>
        <Mat color={C.pcb} rough={0.7} />
      </Box>
      {/* MOSFETs */}
      {[-1, 0, 1].flatMap((i) =>
        [-1, 1].map((j) => (
          <Box key={`${i}${j}`} size={[l * 0.2, w * 0.22, h - board]} at={[i * l * 0.28, j * w * 0.22, z0 + board + (h - board) / 2]}>
            <Mat color={C.chip} />
          </Box>
        )),
      )}
      {/* solder pads along both edges */}
      {Array.from({ length: 6 }, (_, i) =>
        [-1, 1].map((s) => (
          <Box key={`${i}${s}`} size={[l * 0.06, w * 0.06, board * 0.3]} at={[(i - 2.5) * l * 0.15, s * w * 0.44, z0 + board + board * 0.15]}>
            <Mat color={C.copper} metal={0.7} rough={0.3} />
          </Box>
        )),
      )}
    </group>
  )
}

/** Pixhawk-style case: body, lip, top plate, forward arrow, screws, LEDs and a row of port sockets. */
export function FlightControllerModel({ size: [l, w, h], ports = 6 }: { size: Vec3; ports?: number }) {
  const z0 = -h / 2
  const body = h * 0.72
  const lip = h * 0.06
  const top = h * 0.12
  const arrow = useMemo(() => {
    const s = new Shape()
    const k = Math.min(l, w) * 0.12
    s.moveTo(k, 0)
    s.lineTo(-k * 0.7, k * 0.6)
    s.lineTo(-k * 0.35, 0)
    s.lineTo(-k * 0.7, -k * 0.6)
    s.closePath()
    return s
  }, [l, w])
  const sockets = Math.max(1, Math.min(ports, 14))
  return (
    <group>
      <Box size={[l, w, body]} at={[0, 0, z0 + body / 2]}>
        <Mat color={C.dark} rough={0.55} />
      </Box>
      <Box size={[l * 0.99, w * 0.99, lip]} at={[0, 0, z0 + body + lip / 2]}>
        <Mat color={C.metalDark} rough={0.6} />
      </Box>
      <Box size={[l * 0.95, w * 0.95, top]} at={[0, 0, z0 + body + lip + top / 2]}>
        <Mat color={C.dark} rough={0.55} />
      </Box>
      <mesh position={[0, 0, z0 + body + lip + top + h * 0.005]}>
        <shapeGeometry args={[arrow]} />
        <meshStandardMaterial color={C.metal} metalness={0.4} roughness={0.4} />
      </mesh>
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sy) => (
          <Cyl key={`${sx}${sy}`} r={Math.min(l, w) * 0.025} h={h * 0.04} x={sx * l * 0.43} y={sy * w * 0.4} z={z0 + body + lip + top + h * 0.02} n={12}>
            <Mat color={C.metal} metal={0.5} rough={0.4} />
          </Cyl>
        )),
      )}
      {[0, 1, 2].map((i) => (
        <Box key={i} size={[l * 0.02, w * 0.04, h * 0.02]} at={[l * 0.36, -w * 0.3 + i * w * 0.06, z0 + body + lip + top + h * 0.01]}>
          <meshBasicMaterial color={i === 0 ? C.led : C.metalDark} />
        </Box>
      ))}
      {/* port sockets along the rear edge (−X), sized to the case */}
      {Array.from({ length: sockets }, (_, i) => (
        <Box key={i} size={[l * 0.025, (w * 0.9) / sockets - w * 0.012, body * 0.45]} at={[-l / 2 + l * 0.0125, -w * 0.45 + ((i + 0.5) * w * 0.9) / sockets, z0 + body * 0.55]}>
          <Mat color={C.ivory} rough={0.6} />
        </Box>
      ))}
    </group>
  )
}

/** Generic electronics module (GPS, radio, power module, payload): case, top cover, connector. */
export function ModuleModel({ size: [l, w, h] }: { size: Vec3 }) {
  const z0 = -h / 2
  return (
    <group>
      <Box size={[l, w, h * 0.85]} at={[0, 0, z0 + h * 0.425]}>
        <Mat color={C.dark} rough={0.6} />
      </Box>
      <Box size={[l * 0.92, w * 0.92, h * 0.15]} at={[0, 0, h / 2 - h * 0.075]}>
        <Mat color={C.metalDark} rough={0.55} />
      </Box>
      <Box size={[l * 0.04, w * 0.35, h * 0.3]} at={[-l / 2 + l * 0.02, 0, z0 + h * 0.35]}>
        <Mat color={C.ivory} rough={0.6} />
      </Box>
    </group>
  )
}
