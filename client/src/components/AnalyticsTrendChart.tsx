import { useEffect, useRef, useState } from 'react';
import type { AnalyticsSummary } from '../../../contracts/analytics';

export function AnalyticsTrendChart({
  daily,
  metric,
  label,
  formatNumber,
  formatDate,
}: {
  daily: AnalyticsSummary['daily'];
  metric: 'pageviews' | 'visits';
  label: string;
  formatNumber: (value: number) => string;
  formatDate: (value: string) => string;
}) {
  const chart = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const element = chart.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maximum = Math.max(1, ...daily.map((day) => day[metric]));
  const point = (index: number) => ({
    x: 55 + (index * Math.max(1, width - 80)) / Math.max(1, daily.length - 1),
    y: 180 - (daily[index]![metric] / maximum) * 150,
  });
  const line = daily
    .map(
      (_, index) =>
        `${index === 0 ? 'M' : 'L'}${point(index).x},${point(index).y}`,
    )
    .join(' ');
  return (
    <svg
      className="analytics-chart"
      ref={chart}
      viewBox={`0 0 ${width} 220`}
      role="img"
      aria-label={label}
    >
      <line
        x1="55"
        y1="180"
        x2={width - 25}
        y2="180"
        className="analytics-chart-axis"
      />
      <text x="45" y="35" textAnchor="end">
        {formatNumber(maximum)}
      </text>
      <text x="45" y="184" textAnchor="end">
        0
      </text>
      <path d={line} fill="none" className="analytics-chart-line" />
      {daily.length === 1 ? (
        <circle
          cx={point(0).x}
          cy={point(0).y}
          r="4"
          className="analytics-chart-point"
        />
      ) : null}
      {daily.map((day, index) =>
        index === 0 ||
        index === daily.length - 1 ||
        index % Math.ceil(daily.length / (width < 480 ? 2 : 4)) === 0 ? (
          <text
            key={day.date}
            x={point(index).x}
            y="208"
            textAnchor={
              index === 0
                ? 'start'
                : index === daily.length - 1
                  ? 'end'
                  : 'middle'
            }
          >
            {formatDate(day.date)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
