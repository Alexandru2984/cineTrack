import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GenreDonut } from '@/components/GenreDonut';
import { MonthlyActivityChart } from '@/components/MonthlyActivityChart';
import { niceCeiling } from '@/lib/chartScale';

describe('niceCeiling', () => {
  it('rounds up to one, two or five times a power of ten', () => {
    expect(niceCeiling(44.9)).toBe(50);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(1.4)).toBe(2);
    expect(niceCeiling(230)).toBe(500);
  });

  it('never returns zero, which would divide the axis by nothing', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-5)).toBe(1);
  });
});

describe('MonthlyActivityChart', () => {
  const data = [
    { month: 'Dec', hours: 44.9 },
    { month: 'Nov', hours: 0 },
    { month: 'Oct', hours: 15.2 },
  ];

  it('labels the axis with round numbers', () => {
    // The axis divided by four produced 0 / 13 / 25 / 38 / 50 — labels that do
    // not sit on the lines they name. Every ceiling this can produce divides
    // into five cleanly.
    const { container } = render(
      <MonthlyActivityChart data={data} describePoint={() => 'x'} />,
    );
    const labels = Array.from(container.querySelectorAll('span'))
      .map((node) => node.textContent)
      .filter((text) => text && /^\d+$/.test(text));

    expect(labels).toEqual(expect.arrayContaining(['50', '40', '30', '20', '10', '0']));
  });

  it('gives a month with no activity a visible column to hover', () => {
    const { container } = render(
      <MonthlyActivityChart
        data={data}
        describePoint={(point) => `${point.month}: ${point.hours}`}
      />,
    );
    const bars = container.querySelectorAll('[title]');
    expect(bars).toHaveLength(3);

    const november = Array.from(bars).find((bar) =>
      bar.getAttribute('title')?.startsWith('Nov'),
    );
    // Not zero height: an absent column cannot be hovered to find out it is
    // zero, which is the one thing the reader wants to know.
    expect((november as HTMLElement).style.height).toBe('1%');
  });

  it('scales the tallest column against the rounded ceiling, not itself', () => {
    const { container } = render(
      <MonthlyActivityChart data={data} describePoint={(point) => point.month} />,
    );
    const december = container.querySelector('[title="Dec"]') as HTMLElement;
    // 44.9 of a ceiling of 50 — short of the top, which is the point of
    // rounding the axis up.
    expect(december.style.height).toBe('89.8%');
  });
});

describe('GenreDonut', () => {
  const slices = [
    { label: 'Drama', value: 50, color: '#8b5cf6' },
    { label: 'Comedy', value: 30, color: '#a78bfa' },
    { label: 'Other', value: 20, color: '#666' },
  ];

  it('draws one arc per slice, each sized by its share', () => {
    const { container } = render(
      <GenreDonut slices={slices} describeSlice={(slice) => slice.label} />,
    );
    const arcs = container.querySelectorAll('circle');
    expect(arcs).toHaveLength(3);

    const circumference = 2 * Math.PI * 34;
    const drawn = Array.from(arcs).map((arc) =>
      Number(arc.getAttribute('stroke-dasharray')?.split(' ')[0]),
    );
    // Halves, thirds and fifths of the ring, each less the separating gap.
    expect(drawn[0]).toBeCloseTo(circumference * 0.5 - 1.6, 5);
    expect(drawn[1]).toBeCloseTo(circumference * 0.3 - 1.6, 5);
    expect(drawn[2]).toBeCloseTo(circumference * 0.2 - 1.6, 5);
  });

  it('starts each slice where the previous one ended', () => {
    const { container } = render(
      <GenreDonut slices={slices} describeSlice={(slice) => slice.label} />,
    );
    const circumference = 2 * Math.PI * 34;
    const offsets = Array.from(container.querySelectorAll('circle')).map((arc) =>
      Number(arc.getAttribute('stroke-dashoffset')),
    );

    // Zero, not minus zero: the negation happens before it becomes an
    // attribute, and "-0" serialises as "0".
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeCloseTo(-circumference * 0.5, 5);
    expect(offsets[2]).toBeCloseTo(-circumference * 0.8, 5);
  });

  it('does not notch a ring that has only one slice', () => {
    const { container } = render(
      <GenreDonut
        slices={[{ label: 'Drama', value: 7, color: '#8b5cf6' }]}
        describeSlice={(slice) => slice.label}
      />,
    );
    const arc = container.querySelector('circle');
    const circumference = 2 * Math.PI * 34;
    // A gap needs two slices to sit between; in a lone ring it is just a cut.
    expect(Number(arc?.getAttribute('stroke-dasharray')?.split(' ')[0])).toBeCloseTo(
      circumference,
      5,
    );
  });

  it('renders nothing rather than dividing by a total of zero', () => {
    const { container } = render(
      <GenreDonut
        slices={[{ label: 'Drama', value: 0, color: '#8b5cf6' }]}
        describeSlice={(slice) => slice.label}
      />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('gives every slice hover and screen-reader text', () => {
    const { container } = render(
      <GenreDonut
        slices={slices}
        describeSlice={(slice, percent) => `${slice.label}: ${Math.round(percent)}%`}
      />,
    );
    const titles = Array.from(container.querySelectorAll('title')).map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(['Drama: 50%', 'Comedy: 30%', 'Other: 20%']);
  });
});
