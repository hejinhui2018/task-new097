import type { TempSegment } from '../types';
import { tempAt } from './segments';

export interface DriftResult {
  /** 保温中段相对探针中位温度的平均持续偏差 °C（负=偏冷） */
  residual: number;
  /** 用于比较的有效配对比数 */
  pairedPoints: number;
}

/**
 * 保温中段（默认去掉前后各 20% 爬升/回落）各探针相对中位温度的持续偏差。
 * 仅在两个通道都能在该时刻线性插值取温时配对；缺配比例过高返回 null（交由覆盖门禁处理）。
 */
export function driftResidual(
  self: TempSegment[],
  others: TempSegment[][],
  holdStart: number,
  holdEnd: number,
  stepMs: number,
  minCoverage = 0.6,
): DriftResult | null {
  const span = holdEnd - holdStart;
  const a = holdStart + span * 0.2;
  const b = holdEnd - span * 0.2;
  if (!(b > a) || stepMs <= 0) return null;

  let sum = 0;
  let n = 0;
  let possible = 0;
  for (let t = a; t <= b; t += stepMs) {
    possible++;
    const mine = tempAt(self, t);
    if (mine === null) continue;
    const vals: number[] = [];
    for (const o of others) {
      const v = tempAt(o, t);
      if (v !== null) vals.push(v);
    }
    if (vals.length === 0) continue;
    vals.sort((x, y) => x - y);
    const mid =
      vals.length % 2
        ? vals[(vals.length - 1) / 2]
        : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    sum += mine - mid;
    n++;
  }
  if (possible === 0 || n / possible < minCoverage) return null;
  return { residual: sum / n, pairedPoints: n };
}

export interface ClockLagResult {
  /** 建议校时偏移 ms（加到探针时间戳上） */
  lagMs: number;
  /** 配对比数 */
  pairs: number;
  /** 校时前后的均方误差改善比例（0-1） */
  improvement: number;
}

/**
 * 以其他探针的中位曲线为基准，在升温段搜索使本探针最佳对齐的整体时钟偏移。
 * 用探针组互比（而非釜温）以避开正常的热滞后：热惯性差异表现为波形差异，
 * 单纯时钟错位表现为整条升温曲线平移。只产出候选，不改写原始数据。
 * 数据不足、对齐改善不显著、偏移小于 2 个采样节拍或解落在搜索边界时返回 null。
 */
export function suggestClockLag(
  probe: TempSegment[],
  peers: TempSegment[][],
  windowStart: number,
  holdStart: number,
  probeStepMs: number,
): ClockLagResult | null {
  if (!(holdStart > windowStart) || probe.length === 0 || peers.length === 0) return null;

  const maxLagMs = 180_000;
  const step = Math.max(5_000, Math.round(probeStepMs));
  const evalStep = Math.max(step, 10_000);

  const shifted = (segs: TempSegment[], lag: number): TempSegment[] =>
    segs.map((s) => ({ ...s, t1: s.t1 + lag, t2: s.t2 + lag }));

  const score = (lag: number): { sse: number; n: number } => {
    const p = shifted(probe, lag);
    let sse = 0;
    let n = 0;
    for (let t = windowStart; t <= holdStart; t += evalStep) {
      const mine = tempAt(p, t);
      if (mine === null) continue;
      const vals: number[] = [];
      for (const o of peers) {
        const v = tempAt(o, t);
        if (v !== null) vals.push(v);
      }
      if (vals.length === 0) continue;
      // 平台/低温段对平移不敏感，只在显著升温区评分
      vals.sort((a, b) => a - b);
      const mid = vals[Math.floor(vals.length / 2)];
      if (mid < 50 || mid > 118) continue;
      const d = mine - mid;
      sse += d * d;
      n++;
    }
    return { sse, n };
  };

  const base = score(0);
  if (base.n < 10) return null;

  let best = { lag: 0, sse: base.sse };
  for (let lag = -maxLagMs; lag <= maxLagMs; lag += step) {
    if (lag === 0) continue;
    const s = score(lag);
    if (s.n < base.n * 0.8) continue;
    if (s.sse < best.sse) best = { lag, sse: s.sse };
  }

  const minLag = Math.max(2 * probeStepMs, 5_000);
  const improvement = (base.sse - best.sse) / base.sse;
  if (Math.abs(best.lag) < minLag || improvement < 0.35) return null;
  // 落在搜索边界通常意味着热惯性差异（非平移），拒绝
  if (Math.abs(best.lag) >= maxLagMs - step / 2) return null;
  return { lagMs: best.lag, pairs: base.n, improvement };
}
