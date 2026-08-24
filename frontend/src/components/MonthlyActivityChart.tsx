/** A column chart built from divs.
 *
 *  This replaced recharts, whose two charts cost 105 KiB gzipped on this page.
 *  Bars are laid out by flexbox and sized as a percentage of the tallest, so
 *  there is nothing to measure and it reflows with the container — which is
 *  what `ResponsiveContainer` was doing the expensive way.
 */

import { niceCeiling } from '@/lib/chartScale';

export interface MonthlyPoint {
  month: string;
  hours: number;
}

/** Five divisions, not four.
 *
 *  `niceCeiling` always returns 1, 2 or 5 times a power of ten. Divided by four
 *  that gives 12.5 for a ceiling of 50, and the axis read 0 / 13 / 25 / 38 / 50
 *  — rounded labels that do not match the lines they sit on. Every one of those
 *  ceilings divides by five into something clean. */
const TICK_COUNT = 5;

export function MonthlyActivityChart({
  data,
  describePoint,
}: {
  data: MonthlyPoint[];
  /** Hover and screen-reader text for one column. */
  describePoint: (point: MonthlyPoint) => string;
}) {
  if (data.length === 0) return null;

  const ceiling = niceCeiling(Math.max(...data.map((point) => point.hours)));
  const step = ceiling / TICK_COUNT;
  // A ceiling under five divides into fractions, and rounding those to whole
  // numbers repeats the same label down the axis.
  const decimals = step < 1 ? 1 : 0;
  // Top down, because that is the order they are drawn in.
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, index) =>
    (step * (TICK_COUNT - index)).toFixed(decimals),
  );

  return (
    <div>
      <div className="flex h-[300px] gap-2">
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
          {ticks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>

        <div className="relative flex-1">
          {ticks.map((tick, index) => (
            <div
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 border-t border-[hsl(var(--border))]"
              style={{ top: `${(index / TICK_COUNT) * 100}%` }}
            />
          ))}

          <div className="absolute inset-0 flex items-end gap-1">
            {data.map((point) => (
              <div
                key={point.month}
                // `title` rather than a hover card: it is what the heatmap on
                // this same page already uses, it works on keyboard focus, and
                // it is not another thing to position.
                title={describePoint(point)}
                aria-label={describePoint(point)}
                className="min-w-0 flex-1 rounded-t bg-[hsl(262_83%_58%)] transition-opacity hover:opacity-80"
                // A month with no activity still gets a sliver, so the column
                // is present to hover rather than missing entirely.
                style={{ height: `${Math.max((point.hours / ceiling) * 100, 1)}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-1 flex gap-1 pl-10">
        {data.map((point) => (
          <span
            key={point.month}
            className="min-w-0 flex-1 truncate text-center text-xs text-[hsl(var(--muted-foreground))]"
          >
            {point.month}
          </span>
        ))}
      </div>
    </div>
  );
}
