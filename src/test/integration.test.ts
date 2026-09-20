import { describe, it, expect } from 'vitest';
import { lethalityRate, segmentLethality } from '../lib/lethality';
import { buildSegments, integrateWindow, cumulativeUntil, tempAt } from '../lib/segments';
import { linearRamp, flatSamples, CAME_UP, HOLD, END, makeDataset, makeSettings } from './fixtures';
import { analyze } from '../lib/analyze';

describe('致死率积分 — 不规则采样与线性插值', () => {
  it('121.1 °C 恒温 6 分钟应恰好为 F0=6', () => {
    const f = segmentLethality(0, 6 * 60_000, 121.1, 121.1, 121.1, 10);
    expect(f).toBeCloseTo(6, 10);
    expect(lethalityRate(121.1, 121.1, 10)).toBeCloseTo(1, 12);
  });

  it('温度每升高 z 值，瞬时致死率提高 10 倍', () => {
    expect(lethalityRate(131.1, 121.1, 10) / lethalityRate(121.1, 121.1, 10)).toBeCloseTo(10, 10);
  });

  it('线性升温斜坡的解析积分与极细梯形数值积分一致', () => {
    // 600 s 内由 100 升到 125 °C
    const analytic = segmentLethality(0, 600_000, 100, 125, 121.1, 10);
    let numeric = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const ta = (i / n) * 600_000;
      const tb = ((i + 1) / n) * 600_000;
      const Ta = 100 + (25 * ta) / 600_000;
      const Tb = 100 + (25 * tb) / 600_000;
      numeric += ((lethalityRate(Ta, 121.1, 10) + lethalityRate(Tb, 121.1, 10)) / 2) * ((tb - ta) / 60_000);
    }
    expect(analytic).toBeCloseTo(numeric, 4);
  });

  it('解析积分随时间长度线性缩放', () => {
    const a = segmentLethality(0, 120_000, 118, 122, 121.1, 10);
    const b = segmentLethality(0, 360_000, 118, 122, 121.1, 10);
    // 注意不同长度终点不同，不应简单三倍；改用等温段验证线性
    const iso1 = segmentLethality(0, 120_000, 120, 120, 121.1, 10);
    const iso2 = segmentLethality(0, 360_000, 120, 120, 121.1, 10);
    expect(iso2).toBeCloseTo(3 * iso1, 10);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it('不规则采样与等间隔采样描述同一过程时，累计 F0 一致', () => {
    const irregularTimes = [0, 13, 47, 95, 150, 230, 310, 420, 510, 600];
    const regularTimes = Array.from({ length: 61 }, (_, i) => i * 10);
    const irr = buildSegments(linearRamp(irregularTimes, 100, 125), 600_000);
    const reg = buildSegments(linearRamp(regularTimes, 100, 125), 600_000);
    const fIrr = integrateWindow(irr.segments, 0, 600_000, 121.1, 10);
    const fReg = integrateWindow(reg.segments, 0, 600_000, 121.1, 10);
    expect(fIrr).toBeCloseTo(fReg, 2);
  });

  it('短缺测缺口按两端读数线性插值积分并标记 interpolatedGap', () => {
    // 120s 处缺测，相邻有效读数 90s→150s（跨度 60s，恰在允许内）线性插值
    const samples = [
      ...flatSamples([0, 45, 90], 110),
      { t: 120_000, temp: null },
      ...flatSamples([150, 195, 240], 110),
    ];
    const built = buildSegments(samples, 60_000);
    expect(built.longGaps).toHaveLength(0);
    const gapSeg = built.segments.find((s) => s.interpolatedGap);
    expect(gapSeg).toBeDefined();
    expect(tempAt(built.segments, 120_000)).toBeCloseTo(110, 6);
  });

  it('累计 F0 单调不减，且等于终点累计值', () => {
    const samples = linearRamp(Array.from({ length: 21 }, (_, i) => i * 30), 90, 124);
    const built = buildSegments(samples, 600_000);
    let prev = -1;
    for (let s = 0; s <= 600; s += 37) {
      const f = cumulativeUntil(built.segments, s * 1000, 121.1, 10);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f;
    }
    expect(cumulativeUntil(built.segments, 600_000, 121.1, 10)).toBeCloseTo(
      integrateWindow(built.segments, 0, 600_000, 121.1, 10),
      10,
    );
  });

  it('内置示例数据可分析且保温贡献占主导', () => {
    const ds = makeDataset();
    const a = analyze(ds, makeSettings(), { offsets: {}, disabled: {} });
    const cold = a.channels.find((c) => c.id === a.coldPointId);
    expect(cold).toBeDefined();
    const hold = cold!.phases.hold!.f;
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeGreaterThan(cold!.phases.cool!.f);
    expect([CAME_UP, HOLD, END]).toHaveLength(3);
  });
});
