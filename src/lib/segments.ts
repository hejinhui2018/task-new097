import type { RawSample, TempSegment, GapRange } from '../types';
import { segmentLethality } from './lethality';

export interface BuiltSegments {
  /** 时间严格递增的可积温度直线段（已剔除时间倒退对与长缺口对） */
  segments: TempSegment[];
  /** 未积分的长缺口（禁止补零、禁止沿用上一温度） */
  longGaps: GapRange[];
  /** 发生时间倒退（t_i <= t_{i-1}）的位置与倒退量 ms */
  regressions: { index: number; at: number; deltaMs: number }[];
  firstT: number | null;
  lastT: number | null;
  /** 相邻读数间隔的中位 cadence（ms），用于时钟异常判断 */
  medianStepMs: number | null;
}

/**
 * 由原始采样构建可积线段。
 * - 只连接“相邻两个有效读数”；中间缺测以线性插值跨过（标记 interpolatedGap）。
 * - 不补零、不沿用保持（hold-last），缺测区间不构造任何水平线段。
 * - 时间倒退：记录证据并跳过该对，绝不重排（重排会掩盖时钟错误）。
 * - 长缺口（间隔 > maxGapMs）：不积分，记入 longGaps。
 */
export function buildSegments(samples: RawSample[], maxGapMs: number): BuiltSegments {
  const segments: TempSegment[] = [];
  const longGaps: GapRange[] = [];
  const regressions: { index: number; at: number; deltaMs: number }[] = [];
  const steps: number[] = [];

  let prev: RawSample | null = null;
  let skippedSincePrev = false;
  let firstT: number | null = null;
  let lastT: number | null = null;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (firstT === null && s.t !== null) firstT = s.t;
    if (s.t !== null) lastT = s.t;

    if (s.temp === null) {
      if (prev) skippedSincePrev = true;
      continue;
    }
    if (prev === null) {
      prev = s;
      skippedSincePrev = false;
      continue;
  }

    const dt = s.t - prev.t;
    if (dt <= 0) {
      regressions.push({ index: i, at: s.t, deltaMs: dt });
      // 倒退点不更新锚点，也不参与积分
      continue;
    }
    steps.push(dt);
    if (dt > maxGapMs) {
      longGaps.push({ from: prev.t, to: s.t });
    } else {
      segments.push({
        t1: prev.t,
        t2: s.t,
        T1: prev.temp as number,
        T2: s.temp,
        interpolatedGap: skippedSincePrev,
      });
    }
    prev = s;
    skippedSincePrev = false;
  }

  return {
    segments,
    longGaps,
    regressions,
    firstT,
    lastT,
    medianStepMs: median(steps),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 裁剪线段到 [a,b]，无交集返回 null */
export function clipSegment(
  seg: TempSegment,
  a: number,
  b: number,
): { t1: number; t2: number; T1: number; T2: number } | null {
  const lo = Math.max(seg.t1, a);
  const hi = Math.min(seg.t2, b);
  if (lo >= hi) return null;
  const Tlo = seg.T1 + ((seg.T2 - seg.T1) * (lo - seg.t1)) / (seg.t2 - seg.t1);
  const Thi = seg.T1 + ((seg.T2 - seg.T1) * (hi - seg.t1)) / (seg.t2 - seg.t1);
  return { t1: lo, t2: hi, T1: Tlo, T2: Thi };
}

/** 区间 [a,b] 内的 F0 积分（min） */
export function integrateWindow(
  segments: TempSegment[],
  a: number,
  b: number,
  refTemp: number,
  zValue: number,
): number {
  let f = 0;
  for (const seg of segments) {
    if (seg.t2 <= a) continue;
    if (seg.t1 >= b) break;
    const c = clipSegment(seg, a, b);
    if (c) f += segmentLethality(c.t1, c.t2, c.T1, c.T2, refTemp, zValue);
  }
  return f;
}

/** t 时刻的线性插值温度；落在缺口/区间外返回 null */
export function tempAt(segments: TempSegment[], t: number): number | null {
  for (const seg of segments) {
    if (t < seg.t1 || t > seg.t2) continue;
    if (seg.t1 === seg.t2) return seg.T1;
    return seg.T1 + ((seg.T2 - seg.T1) * (t - seg.t1)) / (seg.t2 - seg.t1);
  }
  return null;
}

/** 截至 t 的累计 F0（min），用于累计曲线与游标读数 */
export function cumulativeUntil(
  segments: TempSegment[],
  t: number,
  refTemp: number,
  zValue: number,
): number {
  let f = 0;
  for (const seg of segments) {
    if (seg.t2 <= t) {
      f += segmentLethality(seg.t1, seg.t2, seg.T1, seg.T2, refTemp, zValue);
    } else if (seg.t1 < t) {
      f += segmentLethality(seg.t1, t, seg.T1, tempAt(segments, t) ?? seg.T2, refTemp, zValue);
      break;
    } else {
      break;
    }
  }
  return f;
}

/** 区间内是否存在未积分长缺口（含边界相交） */
export function windowHasLongGap(gaps: GapRange[], a: number, b: number): boolean {
  return gaps.some((g) => g.to > a && g.from < b);
}
