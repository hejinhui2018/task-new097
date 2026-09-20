import type { ChannelResult, TempSegment } from '../types';
import { tempAt, cumulativeUntil } from './segments';
import { lethalityRate, MINUTE_MS } from './lethality';

export interface Polyline {
  /** 含 null 的点序列，null 表示该位置处于长缺口（断线） */
  points: ({ x: number; y: number } | null)[];
  xs: number[];
}

/** 在统一时间网格上对通道线段采样，长缺口处断线（不补零、不外推） */
export function samplePolyline(
  segments: TempSegment[],
  start: number,
  end: number,
  maxPoints: number,
  yAt: (t: number, segTemp: number | null) => number | null,
): Polyline {
  const points: ({ x: number; y: number } | null)[] = [];
  const xs: number[] = [];
  const span = Math.max(1, end - start);
  for (let i = 0; i <= maxPoints; i++) {
    const t = start + (span * i) / maxPoints;
    xs.push(t);
    const T = tempAt(segments, t);
    const y = T === null ? null : yAt(t, T);
    points.push(y === null ? null : { x: t, y });
  }
  return { points, xs };
}

export function tempPolyline(ch: ChannelResult, start: number, end: number, maxPoints: number): Polyline {
  return samplePolyline(ch.segments, start, end, maxPoints, (_t, T) => T);
}

export function cumulativePolyline(
  ch: ChannelResult,
  start: number,
  end: number,
  maxPoints: number,
  refTemp: number,
  zValue: number,
): Polyline {
  return samplePolyline(ch.segments, start, end, maxPoints, (t) =>
    cumulativeUntil(ch.segments, t, refTemp, zValue),
  );
}

/** 游标时刻的通道读数 */
export interface CursorRow {
  id: string;
  name: string;
  kind: ChannelResult['kind'];
  temp: number | null;
  rate: number | null;
  cumulative: number | null;
  disabled: boolean;
  eligible: boolean;
}

export function cursorRows(channels: ChannelResult[], t: number, refTemp: number, zValue: number): CursorRow[] {
  return channels.map((ch) => {
    const T = tempAt(ch.segments, t);
    return {
      id: ch.id,
      name: ch.name,
      kind: ch.kind,
      temp: T,
      rate: T === null ? null : lethalityRate(T, refTemp, zValue),
      cumulative: T === null ? null : cumulativeUntil(ch.segments, t, refTemp, zValue),
      disabled: ch.disabled,
      eligible: ch.eligible,
    };
  });
}

export function fmtF(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtRate(v: number | null): string {
  if (v === null) return '—';
  if (v === 0) return '0';
  if (v < 0.001 || v >= 1000) return v.toExponential(2);
  return v.toPrecision(3);
}

/** mm:ss 解析（相对秒），失败返回 null */
export function parseClock(s: string): number | null {
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] === undefined ? 0 : Number(m[3]);
  const ms = m[3] === undefined ? (a * 60 + b) * 1000 : (a * 3600 + b * 60 + c) * 1000;
  return ms;
}

export function fmtClockShort(t: number): string {
  const s = Math.round(t / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export { MINUTE_MS };
