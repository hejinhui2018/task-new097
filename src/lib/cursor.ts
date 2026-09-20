/** 游标时刻的逐通道派生值：瞬时温度/致死率与截至该时刻的累计 F0（缺口区间不计） */
import { interpAt, lethalityRate, segmentF, type Point } from "./lethality";
import type { ProcessParams } from "../types";

export interface CursorRow {
  id: string;
  name: string;
  role: "retort" | "probe";
  temp: number;
  rate: number; // min^-1
  cumF: number; // 从窗口起点累计到游标（min），缺口不计
  inGap: boolean;
}

export function cumulativeUntil(points: Point[], w0: number, t: number, p: ProcessParams): { f: number; inGap: boolean } {
  let f = 0;
  let inGap = false;
  if (points.length < 2 || t <= w0) return { f, inGap };
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i].t;
    const t1 = points[i + 1].t;
    const u = Math.max(t0, w0);
    const v = Math.min(t1, t);
    if (v <= u) continue;
    const delta = t1 - t0;
    if (delta > p.maxGapSec) {
      inGap = t > t0 && t < t1;
      continue;
    }
    const r0 = (u - t0) / delta;
    const r1 = (v - t0) / delta;
    const Tu = points[i].temp + r0 * (points[i + 1].temp - points[i].temp);
    const Tv = points[i].temp + r1 * (points[i + 1].temp - points[i].temp);
    f += segmentF(u, v, Tu, Tv, p.refTemp, p.zValue);
  }
  return { f, inGap };
}

export function cursorRows(
  channels: { id: string; name: string; role: "retort" | "probe"; samples: Point[] }[],
  t: number,
  w0: number,
  p: ProcessParams,
): CursorRow[] {
  const rows: CursorRow[] = [];
  for (const ch of channels) {
    const hit = interpAt(ch.samples, t);
    if (!hit) continue;
    const { f, inGap } = cumulativeUntil(ch.samples, w0, t, p);
    rows.push({
      id: ch.id,
      name: ch.name,
      role: ch.role,
      temp: hit.temp,
      rate: lethalityRate(hit.temp, p.refTemp, p.zValue),
      cumF: f,
      inGap: inGap || hit.gapSec > p.maxGapSec,
    });
  }
  return rows;
}
