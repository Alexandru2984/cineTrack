/** Round an axis up to a number a person would choose.
 *
 *  An axis topped at the exact maximum puts the tallest bar flush against the
 *  ceiling and labels it something like 37.4. Rounding to 1, 2 or 5 times a
 *  power of ten gives round gridlines and leaves the tallest bar visibly short
 *  of the top.
 *
 *  Lives here rather than beside the chart so the chart file exports only its
 *  component, which is what React Fast Refresh needs to swap it in place.
 */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
