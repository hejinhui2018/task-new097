/**
 * 致死率与线性插值积分。
 *
 * L(T) = 10^((T - T_ref)/z)  （min^-1）
 * F = ∫ L(T(t)) dt，dt 以分钟计。
 *
 * 温度在相邻采样间按真实时间线性插值。L 是 T 的指数函数，
 * 区间积分使用对数平均致死率（精确积分），而非梯形近似：
 *
 *   ∫_0^1 10^(a+(b-a)u) du = (10^b - 10^a) / ((b-a)·ln10)
 *
 * 这样不规则采样区间也可精确积分，不会因采样疏密产生系统偏差。
 */

export function lethalityRate(temp: number, refTemp: number, zValue: number): number {
  return Math.pow(10, (temp - refTemp) / zValue);
}

/**
 * 单个线性温度区间 [t1,t2]（秒）、端点温度 T1,T2（℃）贡献的 F（min）。
 * 不做任何缺测假设——调用方必须保证端点来自真实采样或真实采样之间的插值。
 */
export function segmentF(
  t1: number,
  t2: number,
  tmp1: number,
  tmp2: number,
  refTemp: number,
  zValue: number,
): number {
  const dtSec = t2 - t1;
  if (dtSec <= 0) return 0;
  const dtMin = dtSec / 60;
  const a = (tmp1 - refTemp) / zValue;
  const b = (tmp2 - refTemp) / zValue;
  if (Math.abs(a - b) < 1e-10) {
    return dtMin * Math.pow(10, a);
  }
  const l1 = Math.pow(10, a);
  const l2 = Math.pow(10, b);
  const logMean = (l2 - l1) / ((b - a) * Math.LN10);
  // 两端致死率都极小（远低于参考温）时分子可能下溢为 0，此时贡献本就可忽略。
  if (!Number.isFinite(logMean) || logMean <= 0) return 0;
  return dtMin * logMean;
}

export interface Point {
  t: number;
  temp: number;
}

export interface InterpResult {
  temp: number;
  /** 括号区间是否为超过允许跨度的缺测 */
  gapSec: number;
}

/**
 * 在有序采样上按真实时间线性取值。
 * - 不做外推：超出首尾采样范围返回 null；
 * - 不补零、不沿用：仅在真实采样之间插值；
 * - 同时返回括号区间跨度，供调用方判定缺口。
 */
export function interpAt(points: Point[], t: number): InterpResult | null {
  if (points.length === 0) return null;
  if (t < points[0].t || t > points[points.length - 1].t) return null;
  // 二分定位
  let lo = 0;
  let hi = points.length - 1;
  if (t === points[lo].t) return { temp: points[lo].temp, gapSec: 0 };
  if (t === points[hi].t) return { temp: points[hi].temp, gapSec: 0 };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const p0 = points[lo];
  const p1 = points[hi];
  if (p1.t === p0.t) return null;
  const r = (t - p0.t) / (p1.t - p0.t);
  return { temp: p0.temp + r * (p1.temp - p0.temp), gapSec: p1.t - p0.t };
}
