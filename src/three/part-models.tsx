/**
 * Detailed procedural models for parts, after the visual design of the original
 * Blaze-Simulator workshop, rebuilt for this Z-up, metre renderer with realistic
 * materials (carbon weave, anodized and bare aluminium, steel, copper, PCB).
 *
 * Each model fills the part's envelope (centred on the origin, Z up) and stays
 * inside it, so a linked part still matches its datasheet size. Models are
 * decoration: sizes, bounds and checks always use the envelope.
 */
import { RoundedBox } from '@react-three/drei'
import { useMemo } from 'react'
import { BufferGeometry, Float32BufferAttribute, LatheGeometry, Quaternion, Shape, Vector2, Vector3, type Material } from 'three'
import { materials } from './materials'
import type { Vec3 } from './views'

/** Cylinder along Z (three.js cylinders run along Y). */
function Cyl({ r, h, z = 0, x = 0, y = 0, n = 36, m }: { r: number; h: number; z?: number; x?: number; y?: number; n?: number; m: Material }) {
  return (
    <mesh position={[x, y, z]} rotation-x={Math.PI / 2} material={m}>
      <cylinderGeometry args={[r, r, h, n]} />
    </mesh>
  )
}

function Box({ size, at = [0, 0, 0], rotZ = 0, m }: { size: Vec3; at?: Vec3; rotZ?: number; m: Material }) {
  return (
    <mesh position={[...at]} rotation-z={rotZ} material={m}>
      <boxGeometry args={[...size]} />
    </mesh>
  )
}

/** Rounded box; `r` is clamped to what the size allows. */
function RBox({ size, at = [0, 0, 0], r, m }: { size: Vec3; at?: Vec3; r: number; m: Material }) {
  const radius = Math.min(r, Math.min(...size) / 2 - 1e-6)
  return <RoundedBox args={[...size]} radius={Math.max(radius, 1e-5)} smoothness={3} position={[...at]} material={m} />
}

/** A surface of revolution about Z from (radius, z) points. */
function Lathe({ points, z = 0, m, n = 48 }: { points: [number, number][]; z?: number; m: Material; n?: number }) {
  const g = useMemo(() => new LatheGeometry(points.map(([r, h]) => new Vector2(r, h)), n), [points, n])
  return <mesh geometry={g} rotation-x={Math.PI / 2} position-z={z} material={m} />
}

// ---- Motor --------------------------------------------------------------------------------------

/**
 * Outrunner: anodized base with a bearing boss, copper windings on the stator in
 * the gap, a lathe-turned bell with a rolled top edge and vent slots, an accent
 * band, the prop adapter, shaft and nut. Heights stack to exactly `h`.
 */
export function MotorModel({ radius: r, height: h }: { radius: number; height: number }) {
  const m = materials()
  const z0 = -h / 2
  const base = 0.1 * h
  const gap = 0.12 * h
  const bell = 0.62 * h
  const cap = 0.06 * h
  const top = h - base - gap - bell - cap
  const zb = z0 + base + gap // bell bottom
  const bellProfile = useMemo<[number, number][]>(
    () => [
      [r * 0.86, 0],
      [r * 0.995, 0],
      [r, bell * 0.04],
      [r, bell * 0.86],
      [r * 0.985, bell * 0.95],
      [r * 0.94, bell],
      [r * 0.34, bell],
      [r * 0.34, bell * 0.96],
    ],
    [r, bell],
  )
  return (
    <group>
      <Cyl r={r * 0.9} h={base} z={z0 + base / 2} m={m.anodizedBlack} />
      <Cyl r={r * 0.42} h={base * 0.6} z={z0 + base + base * 0.3} m={m.aluminiumDark} />
      {/* Stator core and windings, seen through the gap under the bell. */}
      <Cyl r={r * 0.7} h={gap} z={z0 + base + gap / 2} m={m.aluminiumDark} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2
        return <Box key={i} size={[r * 0.2, r * 0.16, gap * 0.92]} at={[Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8, z0 + base + gap / 2]} rotZ={a} m={m.copper} />
      })}
      <Lathe points={bellProfile} z={zb} m={m.aluminium} />
      <Cyl r={r * 1.004} h={bell * 0.16} z={zb + bell * 0.2} m={m.anodizedBlack} />
      <Cyl r={r * 1.006} h={bell * 0.025} z={zb + bell * 0.3} m={m.anodizedAccent} />
      {/* Vent slots in the bell top. */}
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6
        return <Box key={i} size={[r * 0.34, r * 0.14, bell * 0.02]} at={[Math.cos(a) * r * 0.64, Math.sin(a) * r * 0.64, zb + bell]} rotZ={a} m={m.chip} />
      })}
      <Cyl r={r * 0.34} h={cap} z={zb + bell + cap / 2} m={m.aluminiumDark} n={24} />
      <Cyl r={r * 0.1} h={top} z={h / 2 - top / 2} m={m.steel} n={16} />
      <Cyl r={r * 0.2} h={top * 0.45} z={h / 2 - (top * 0.45) / 2} m={m.aluminium} n={6} />
    </group>
  )
}

// ---- Propeller -------------------------------------------------------------------------------------

/**
 * One blade along +Y from the hub to radius R: aerofoil sections (a thin lens)
 * with a chord that tapers to a rounded tip, twisted to the pitch angle
 * θ(r) = atan(pitch / (2π r)). The twist is limited so the blade stays within
 * the disc thickness `t` (the part's envelope).
 */
export function bladeGeometry(R: number, t: number, pitch: number): BufferGeometry {
  const sections = 16
  const K = 9 // points per surface
  const positions: number[] = []
  const rings: number[][] = []
  for (let i = 0; i <= sections; i++) {
    const x = 0.12 + (0.86 * i) / sections // r / R
    const r = x * R
    let chord = R * (0.06 + 0.35 * x * (1 - x))
    if (x > 0.88) chord *= 1 - ((x - 0.88) / 0.1) * 0.55
    const thick = chord * 0.09
    let theta = Math.atan(pitch / (2 * Math.PI * r))
    const maxRise = t * 0.85 - thick
    if (chord * Math.sin(theta) > maxRise) theta = Math.asin(Math.max(0, Math.min(1, maxRise / chord)))
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const ring: number[] = []
    for (const side of [1, -1]) {
      for (let k = 0; k < K; k++) {
        const u = side === 1 ? -0.5 + k / (K - 1) : 0.5 - k / (K - 1)
        const z = side * (thick / 2) * Math.sqrt(Math.max(0, 1 - (2 * u) ** 2)) * (1 - 0.25 * u)
        const px = u * chord
        ring.push(positions.length / 3)
        positions.push(px * c - z * s, r, px * s + z * c)
      }
    }
    rings.push(ring)
  }
  const index: number[] = []
  const n = rings[0]!.length
  for (let i = 0; i < rings.length - 1; i++)
    for (let k = 0; k < n; k++) {
      const a = rings[i]![k]!
      const b = rings[i]![(k + 1) % n]!
      const c2 = rings[i + 1]![k]!
      const d = rings[i + 1]![(k + 1) % n]!
      index.push(a, c2, b, b, c2, d)
    }
  // Close the root and the tip with fans.
  for (const [ring, flip] of [[rings[0]!, true], [rings.at(-1)!, false]] as const) {
    for (let k = 1; k < n - 1; k++) index.push(...(flip ? [ring[0]!, ring[k + 1]!, ring[k]!] : [ring[0]!, ring[k]!, ring[k + 1]!]))
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

let swept: Material | null = null
/** A faint swept disc so the prop's reach stays visible when the blades are edge-on. */
function sweptMaterial(): Material {
  if (!swept) {
    const mat = materials().plasticGrey.clone()
    mat.transparent = true
    mat.color.set('#9aa3ad') // lighter than the blades, so the disc reads on the dark grid
    mat.opacity = 0.06
    mat.depthWrite = false
    swept = mat
  }
  return swept
}

export function PropellerModel({
  radius: R,
  height: t,
  blades = 2,
  spin = 'ccw',
  pitch,
  carbon = false,
}: {
  radius: number
  height: number
  blades?: number
  spin?: 'cw' | 'ccw'
  /** Metres per revolution; default 0.45 × diameter (a typical multirotor prop). */
  pitch?: number
  carbon?: boolean
}) {
  const m = materials()
  const blade = useMemo(() => bladeGeometry(R, t, pitch ?? 0.9 * R), [R, t, pitch])
  const hub = Math.min(R * 0.075, R)
  const hubProfile = useMemo<[number, number][]>(
    () => [
      [0, -t / 2],
      [hub, -t / 2],
      [hub, t * 0.15],
      [hub * 0.75, t * 0.42],
      [hub * 0.3, t / 2],
      [0, t / 2],
    ],
    [hub, t],
  )
  return (
    <group scale={[spin === 'cw' ? -1 : 1, 1, 1]}>
      {Array.from({ length: blades }, (_, i) => (
        <mesh key={i} geometry={blade} rotation-z={(i / blades) * Math.PI * 2} material={carbon ? m.carbonBlade : m.plasticGrey} />
      ))}
      <Lathe points={hubProfile} m={carbon ? m.carbon : m.plasticGrey} n={32} />
      <Cyl r={hub * 0.32} h={t} m={m.steel} n={6} />
      <Cyl r={R} h={t * 0.04} n={64} m={sweptMaterial()} />
    </group>
  )
}

// ---- Battery ----------------------------------------------------------------------------------------

let red: Material | null = null
const redLead = () => {
  if (!red) {
    const r = materials().plasticBlack.clone()
    r.color.set('#b23a33')
    red = r
  }
  return red
}

/** LiPo pack: rounded body, wrap label, end caps; power leads with an XT60 and the balance lead on top. */
export function BatteryModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const body = h * 0.88
  const zb = -h / 2 + body / 2
  const lead = (h - body) * 0.45
  const ztop = -h / 2 + body + lead
  return (
    <group>
      <RBox size={[l, w, body]} at={[0, 0, zb]} r={Math.min(w, body) * 0.12} m={m.plasticBlack} />
      <RBox size={[l * 0.6, w * 1.004, body * 1.004]} at={[0, 0, zb]} r={Math.min(w, body) * 0.12} m={m.label} />
      <Box size={[l * 0.16, w * 1.006, body * 0.18]} at={[l * 0.05, 0, zb + body * 0.2]} m={m.plasticWhite} />
      {/* Main leads (red, black) along the top to an XT60 at the back. */}
      {[-1, 1].map((s) => (
        <mesh key={s} rotation-z={Math.PI / 2} position={[-l * 0.2, s * w * 0.12, ztop]} material={s > 0 ? redLead() : m.plasticBlack}>
          <cylinderGeometry args={[lead, lead, l * 0.55, 12]} />
        </mesh>
      ))}
      <Box size={[Math.min(l * 0.14, 0.017), Math.min(w * 0.4, 0.016), (h - body) * 0.95]} at={[-l * 0.44, 0, -h / 2 + body + (h - body) / 2]} m={m.plasticYellow} />
      {/* Balance lead connector at the front. */}
      <Box size={[Math.min(l * 0.08, 0.012), Math.min(w * 0.3, 0.012), (h - body) * 0.8]} at={[l * 0.42, w * 0.2, -h / 2 + body + (h - body) * 0.4]} m={m.plasticWhite} />
    </group>
  )
}

// ---- ESC -------------------------------------------------------------------------------------------------

export function EscModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const board = h * 0.3
  const z0 = -h / 2
  return (
    <group>
      <RBox size={[l, w, board]} at={[0, 0, z0 + board / 2]} r={board * 0.3} m={m.pcb} />
      {[-1, 0, 1].flatMap((i) =>
        [-1, 1].map((j) => <Box key={`${i}${j}`} size={[l * 0.18, w * 0.2, (h - board) * 0.55]} at={[i * l * 0.28, j * w * 0.24, z0 + board + (h - board) * 0.275]} m={m.chip} />),
      )}
      {/* Microcontroller and an electrolytic capacitor. */}
      <Box size={[l * 0.14, w * 0.14, (h - board) * 0.35]} at={[0, 0, z0 + board + (h - board) * 0.175]} m={m.chip} />
      <Cyl r={Math.min(w, h) * 0.18} h={h - board} x={l * 0.38} y={0} z={z0 + board + (h - board) / 2} m={m.aluminium} n={20} />
      {Array.from({ length: 6 }, (_, i) =>
        [-1, 1].map((s) => <Box key={`${i}${s}`} size={[l * 0.06, w * 0.07, board * 0.25]} at={[(i - 2.5) * l * 0.14, s * w * 0.43, z0 + board + board * 0.125]} m={m.gold} />),
      )}
    </group>
  )
}

// ---- Flight controller --------------------------------------------------------------------------------------

/** Pixhawk-style case: rounded body, lip, cover, forward arrow, screws, LEDs and JST-GH sockets on the rear. */
export function FlightControllerModel({ size: [l, w, h], ports = 6 }: { size: Vec3; ports?: number }) {
  const m = materials()
  const z0 = -h / 2
  const body = h * 0.72
  const lip = h * 0.06
  const top = h * 0.12
  const zt = z0 + body + lip + top
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
      <RBox size={[l, w, body]} at={[0, 0, z0 + body / 2]} r={Math.min(l, w) * 0.06} m={m.anodizedBlack} />
      <Box size={[l * 0.99, w * 0.99, lip]} at={[0, 0, z0 + body + lip / 2]} m={m.aluminiumDark} />
      <RBox size={[l * 0.95, w * 0.95, top]} at={[0, 0, z0 + body + lip + top / 2]} r={top * 0.4} m={m.plasticBlack} />
      <mesh position={[0, 0, zt + h * 0.004]} material={m.plasticWhite}>
        <shapeGeometry args={[arrow]} />
      </mesh>
      {[-1, 1].flatMap((sx) => [-1, 1].map((sy) => <Cyl key={`${sx}${sy}`} r={Math.min(l, w) * 0.025} h={h * 0.03} x={sx * l * 0.43} y={sy * w * 0.4} z={zt + h * 0.015} m={m.steel} n={12} />))}
      {[0, 1, 2].map((i) => (
        <Box key={i} size={[l * 0.022, w * 0.04, h * 0.02]} at={[l * 0.36, -w * 0.3 + i * w * 0.06, zt + h * 0.01]} m={i === 0 ? m.ledGreen : i === 1 ? m.ledBlue : m.chip} />
      ))}
      {Array.from({ length: sockets }, (_, i) => (
        <Box key={i} size={[l * 0.03, (w * 0.9) / sockets - w * 0.012, body * 0.42]} at={[-l / 2 + l * 0.015, -w * 0.45 + ((i + 0.5) * w * 0.9) / sockets, z0 + body * 0.55]} m={m.plasticWhite} />
      ))}
    </group>
  )
}

// ---- Peripherals and power module -------------------------------------------------------------------------------

/** GPS / compass puck inside the box envelope: base, white dome, forward arrow and status ring. */
export function GpsModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const r = Math.min(l, w) / 2
  const z0 = -h / 2
  const base = h * 0.62
  const dome = useMemo<[number, number][]>(
    () => [
      [r * 0.98, 0],
      [r * 0.96, (h - base) * 0.35],
      [r * 0.75, (h - base) * 0.8],
      [r * 0.4, h - base],
      [0, h - base],
    ],
    [r, h, base],
  )
  const arrow = useMemo(() => {
    const s = new Shape()
    const k = r * 0.32
    s.moveTo(k, 0)
    s.lineTo(-k * 0.6, k * 0.55)
    s.lineTo(-k * 0.3, 0)
    s.lineTo(-k * 0.6, -k * 0.55)
    s.closePath()
    return s
  }, [r])
  return (
    <group>
      <Cyl r={r} h={base} z={z0 + base / 2} m={m.plasticBlack} n={48} />
      <Cyl r={r * 1.002} h={base * 0.08} z={z0 + base * 0.86} m={m.ledBlue} n={48} />
      <Lathe points={dome} z={z0 + base} m={m.plasticWhite} />
      <mesh position={[0, 0, h / 2 - (h - base) * 0.02]} material={m.plasticBlack}>
        <shapeGeometry args={[arrow]} />
      </mesh>
    </group>
  )
}

/** Telemetry radio: aluminium case, SMA antenna connector on the front, micro-USB and LEDs. The stated size excludes the antenna. */
export function RadioModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const sma = Math.min(l * 0.14, 0.009)
  return (
    <group>
      <RBox size={[l - sma, w, h]} at={[-sma / 2, 0, 0]} r={Math.min(w, h) * 0.12} m={m.aluminiumDark} />
      <mesh position={[l / 2 - sma / 2, 0, 0]} rotation-z={Math.PI / 2} material={m.gold}>
        <cylinderGeometry args={[Math.min(w, h) * 0.22, Math.min(w, h) * 0.22, sma, 6]} />
      </mesh>
      <Box size={[l * 0.04, w * 0.25, h * 0.3]} at={[-l / 2 + l * 0.02, w * 0.2, 0]} m={m.chip} />
      {[0, 1].map((i) => (
        <Box key={i} size={[l * 0.03, w * 0.05, h * 0.04]} at={[l * 0.1 + i * l * 0.06, -w * 0.3, h / 2 - h * 0.02]} m={i ? m.ledGreen : m.ledBlue} />
      ))}
    </group>
  )
}

/** Power module: small board with XT60 connectors at both ends and the sense cable socket. */
export function PowerModuleModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const xt = Math.min(l * 0.3, 0.016)
  return (
    <group>
      <RBox size={[l - 2 * xt * 0.8, w * 0.8, h * 0.35]} at={[0, 0, -h / 2 + h * 0.175]} r={h * 0.08} m={m.pcb} />
      {[-1, 1].map((s) => (
        <Box key={s} size={[xt, Math.min(w, 0.016), h]} at={[s * (l / 2 - xt / 2), 0, 0]} m={m.plasticYellow} />
      ))}
      <Box size={[l * 0.18, w * 0.25, h * 0.4]} at={[0, w * 0.25, -h / 2 + h * 0.55]} m={m.plasticWhite} />
      <Box size={[l * 0.2, w * 0.2, h * 0.25]} at={[0, -w * 0.15, -h / 2 + h * 0.47]} m={m.chip} />
    </group>
  )
}

/** Generic electronics module (payloads without a more specific model). */
export function ModuleModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const z0 = -h / 2
  return (
    <group>
      <RBox size={[l, w, h * 0.85]} at={[0, 0, z0 + h * 0.425]} r={Math.min(l, w, h) * 0.08} m={m.anodizedBlack} />
      <RBox size={[l * 0.92, w * 0.92, h * 0.15]} at={[0, 0, h / 2 - h * 0.075]} r={h * 0.05} m={m.aluminiumDark} />
      <Box size={[l * 0.04, w * 0.35, h * 0.3]} at={[-l / 2 + l * 0.02, 0, z0 + h * 0.35]} m={m.plasticWhite} />
    </group>
  )
}

/** A tube of radius r from a to b (for struts and skids). */
function Tube({ a, b, r, m }: { a: Vec3; b: Vec3; r: number; m: Material }) {
  const { position, quaternion, length } = useMemo(() => {
    const from = new Vector3(...a)
    const dir = new Vector3(...b).sub(from)
    const len = dir.length()
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize())
    return { position: from.add(dir.multiplyScalar(0.5)), quaternion: q, length: len }
  }, [a, b])
  return (
    <mesh position={position} quaternion={quaternion} material={m}>
      <cylinderGeometry args={[r, r, length, 16]} />
    </mesh>
  )
}

/**
 * Camera: housing, a lens barrel looking forward (+X) with its glass, and a
 * mounting tab. Fills the part's envelope; the stated size includes the lens.
 */
export function CameraModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const body = l * 0.62
  const lensR = Math.min(w, h) * 0.32
  const lensL = l - body
  return (
    <group>
      <RBox size={[body, w, h * 0.9]} at={[-l / 2 + body / 2, 0, h * 0.05]} r={Math.min(w, h) * 0.08} m={m.anodizedBlack} />
      <Box size={[body * 0.5, w * 0.6, h * 0.1]} at={[-l / 2 + body * 0.4, 0, -h / 2 + h * 0.05]} m={m.aluminiumDark} />
      <mesh position={[-l / 2 + body + lensL * 0.45, 0, h * 0.05]} rotation-z={-Math.PI / 2} material={m.aluminiumDark}>
        <cylinderGeometry args={[lensR, lensR * 1.1, lensL * 0.9, 32]} />
      </mesh>
      <mesh position={[l / 2 - lensL * 0.05, 0, h * 0.05]} rotation-z={-Math.PI / 2} material={m.lens}>
        <cylinderGeometry args={[lensR * 0.8, lensR * 0.8, lensL * 0.1, 32]} />
      </mesh>
      <Cyl r={Math.min(w, h) * 0.04} h={h * 0.02} x={-l / 2 + body * 0.2} y={w * 0.3} z={h / 2 - h * 0.04} m={m.ledGreen} n={12} />
    </group>
  )
}

/**
 * Landing gear: two skids along X joined to the frame by four angled struts and two
 * cross tubes under a mounting plate. Fills the part's envelope (length = skid
 * length, width = skid spacing, height = the clearance it adds); a display model,
 * not a structural one.
 */
export function LandingGearModel({ size: [l, w, h] }: { size: Vec3 }) {
  const m = materials()
  const r = Math.max(Math.min(l, w, h) * 0.035, 0.0015)
  const top = h / 2 - r
  const bottom = -h / 2 + r
  const sy = w / 2 - r
  const ty = Math.min(w * 0.18, sy)
  const sx = l / 2 - r
  const tx = l * 0.22
  return (
    <group>
      {[-1, 1].map((s) => (
        <group key={s}>
          <Tube a={[-sx, s * sy, bottom]} b={[sx, s * sy, bottom]} r={r} m={m.plasticBlack} />
          <Tube a={[-tx, s * ty, top]} b={[-tx * 1.1, s * sy, bottom]} r={r * 0.8} m={m.carbon} />
          <Tube a={[tx, s * ty, top]} b={[tx * 1.1, s * sy, bottom]} r={r * 0.8} m={m.carbon} />
        </group>
      ))}
      <Tube a={[-tx, -ty, top]} b={[-tx, ty, top]} r={r * 0.8} m={m.carbon} />
      <Tube a={[tx, -ty, top]} b={[tx, ty, top]} r={r * 0.8} m={m.carbon} />
      <Box size={[tx * 2 + r * 4, ty * 2, r * 1.2]} at={[0, 0, h / 2 - r * 0.6]} m={m.anodizedBlack} />
    </group>
  )
}
