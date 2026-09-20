// 致死率（Lethality / F0）数学：温度在真实时间轴上线性变化，时间以 ms 计，F0 以 min 计。

export const MINUTE_MS = 60_000;

/** 瞬时致死率 L(T)=10^((T-Tref)/z)，单位 min^-1 */
export function lethalityRate(tempC: number, refTemp: number, zValue: number): number {
  return Math.pow(10, (tempC - refTemp) / zValue);
}

/**
 * 温度沿 (t1,T1)->(t2,T2) 线性变化时，该时间段对 F0 的积分（min）。
 * 解析解：L1·dt·(r-1)/ln r，r=10^((T2-T1)/z)；等温时退化为 L1·dt。
 * 不允许 t2<t1；缺测段不得调用（由上层门禁排除）。
 */
export function segmentLethality(
  t1: number,
  t2: number,
  T1: number,
  T2: number,
  refTemp: number,
  zValue: number,
): number {
  const dtMs = t2 - t1;
  if (dtMs <= 0) return 0;
  const dtMin = dtMs / MINUTE_MS;
  const dT = T2 - T1;
  const L1 = lethalityRate(T1, refTemp, zValue);
  if (Math.abs(dT) < 1e-9) return L1 * dtMin;
  const r = Math.pow(10, dT / zValue);
  // 温度变化极小时与等温公式数值等价
  if (Math.abs(r - 1) < 1e-9) return L1 * dtMin;
  return (L1 * dtMin * (r - 1)) / Math.log(r);
}
