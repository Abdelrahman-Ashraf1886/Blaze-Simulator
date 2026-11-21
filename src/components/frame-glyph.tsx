import { FRAME_SPECS, type FrameType } from '../../electron/ipc/contract'

/**
 * Top-down sketch of a multirotor layout. "X" orientation: forward is up and
 * sits between the two front arms, so arm i points at -90° + 180°/n + i·360°/n.
 */
export function FrameGlyph({ type, className }: { type: FrameType; className?: string }) {
  const n = FRAME_SPECS[type].rotors
  const arm = n === 8 ? 7.6 : 7.2
  const rotor = n === 4 ? 2.6 : n === 6 ? 2.2 : 1.8
  const tips = Array.from({ length: n }, (_, i) => {
    const a = ((-90 + 180 / n + (360 / n) * i) * Math.PI) / 180
    return [10 + arm * Math.cos(a), 10 + arm * Math.sin(a)] as const
  })
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden>
      {tips.map(([x, y], i) => (
        <line key={`arm${i}`} x1={10} y1={10} x2={x} y2={y} />
      ))}
      {tips.map(([x, y], i) => (
        <circle key={`rotor${i}`} cx={x} cy={y} r={rotor} />
      ))}
      <circle cx={10} cy={10} r={1.7} fill="currentColor" stroke="none" />
    </svg>
  )
}
