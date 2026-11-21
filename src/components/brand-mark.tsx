/** Application mark: a quad-X seen from above. Same geometry as build/icon.svg. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M7 7 17 17M17 7 7 17" stroke="var(--color-fg)" strokeWidth={1.9} strokeLinecap="round" />
      <g fill="none" stroke="var(--color-accent)" strokeWidth={1.5}>
        <circle cx={7} cy={7} r={3.1} />
        <circle cx={17} cy={7} r={3.1} />
        <circle cx={7} cy={17} r={3.1} />
        <circle cx={17} cy={17} r={3.1} />
      </g>
      <rect x={9.9} y={9.9} width={4.2} height={4.2} rx={1} fill="var(--color-fg)" />
    </svg>
  )
}
