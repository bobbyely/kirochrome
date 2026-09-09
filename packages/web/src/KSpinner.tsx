/**
 * The working indicator: a blocky K whose arms sweep.
 *
 * Drawn on a 12x12 grid of 2px cells so it reads as pixel art, and animated
 * with `steps()` so the arms snap between positions rather than gliding —
 * smooth interpolation is what would make it look like a generic spinner.
 */
export function KSpinner({ size = 14, label = "Working" }: { size?: number; label?: string }) {
  // Two diagonals from the stem: the upper arm rises, the lower arm falls.
  const upper = [
    [6, 4],
    [8, 2],
  ];
  const lower = [
    [6, 6],
    [8, 8],
  ];

  return (
    <span className="kspin-wrap" role="status" aria-label={label}>
      <svg className="kspin" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
        {/* stem */}
        <rect x="1" y="1" width="2" height="10" />
        {/* elbow — always lit, so the glyph stays a K */}
        <rect x="3" y="5" width="2" height="2" />
        {upper.map(([x, y], i) => (
          <rect key={`u${x}`} x={x} y={y} width="2" height="2" style={{ animationDelay: `${i * 0.12}s` }} />
        ))}
        {lower.map(([x, y], i) => (
          <rect key={`l${x}`} x={x} y={y} width="2" height="2" style={{ animationDelay: `${i * 0.12 + 0.24}s` }} />
        ))}
      </svg>
      <span className="kspin-label">{label}</span>
    </span>
  );
}
