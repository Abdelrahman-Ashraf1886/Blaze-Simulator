// documentation/plans/phase-5-flight-control.md:63 (D6)
export function ExactSignalsNotice() {
  return (
    <p className="border-t border-line py-2 text-[12.5px] text-warn">
      The signals are exact (no sensor noise, filtering or delay), so responses look better than on a real vehicle.
    </p>
  )
}

