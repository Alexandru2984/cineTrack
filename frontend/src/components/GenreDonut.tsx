/** A donut drawn with one SVG circle per slice.
 *
 *  This replaced recharts, which cost 105 KiB gzipped on this page to draw two
 *  charts. The technique is the old dash-array one: every slice is the same
 *  circle, stroked for the length of its own share and offset past the slices
 *  before it. No path arithmetic, no layout measurement, and it scales with its
 *  container because the viewBox does the work.
 */

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

/** Geometry in viewBox units. The ratio of inner to outer radius is what makes
 *  it read as a ring rather than a pie; 25/43 keeps the proportions the
 *  recharts version had. */
const RADIUS = 34;
const STROKE = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Gap between slices, in the same units as the circumference. Mirrors the
 *  paddingAngle the old chart used: it separates neighbours of similar colour
 *  so two adjacent purples do not read as one slice. */
const GAP = 1.6;

interface DrawnSlice {
  slice: DonutSlice;
  percent: number;
  length: number;
  offset: number;
}

/** Where each slice starts and how far it runs, as a prefix sum over the
 *  shares. A module-level function rather than a loop in the component body:
 *  accumulating into a variable during render is exactly what React's
 *  immutability rule forbids, and it is right to — a re-render that ran the
 *  loop twice would double every offset. */
function layoutSlices(slices: DonutSlice[], total: number): DrawnSlice[] {
  // A single slice is a whole ring, and a gap in it would be a notch in a
  // circle with no neighbour to be separated from.
  const gap = slices.length > 1 ? GAP : 0;

  return slices.reduce<DrawnSlice[]>((drawn, slice) => {
    const previous = drawn[drawn.length - 1];
    const offset = previous ? previous.offset + (previous.slice.value / total) * CIRCUMFERENCE : 0;
    const share = slice.value / total;
    drawn.push({
      slice,
      percent: share * 100,
      length: Math.max(share * CIRCUMFERENCE - gap, 0),
      offset,
    });
    return drawn;
  }, []);
}

export function GenreDonut({
  slices,
  describeSlice,
}: {
  slices: DonutSlice[];
  /** Hover and screen-reader text for one slice. */
  describeSlice: (slice: DonutSlice, percent: number) => string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return null;

  const drawn = layoutSlices(slices, total);

  return (
    <svg
      viewBox="0 0 100 100"
      className="mx-auto h-[260px] w-full max-w-[260px]"
      role="img"
      aria-label={slices.map((slice) => slice.label).join(', ')}
    >
      {/* Start at twelve o'clock. SVG angles begin at three, which puts the
          largest slice somewhere nobody looks first. */}
      <g transform="rotate(-90 50 50)">
        {drawn.map(({ slice, percent, length, offset: dashOffset }) => (
          <circle
            key={slice.label}
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
            strokeDashoffset={-dashOffset}
            // Set through style, not the stroke attribute: presentation
            // attributes are not CSS, so a var() inside one is never resolved
            // and the slice would render black.
            style={{ stroke: slice.color }}
          >
            <title>{describeSlice(slice, percent)}</title>
          </circle>
        ))}
      </g>
    </svg>
  );
}
