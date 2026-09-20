import { describe, it, expect } from 'vitest';
import { analyze } from '../lib/analyze';
import { makeDataset, makeSettings } from './fixtures';
import { buildSegments } from '../lib/segments';
import { flatSamples } from './fixtures';
import { EMPTY_ADJUSTMENTS } from '../lib/state';

describe('数据质量门禁', () => {
  it('保温段长缺口：不积分、不补零、探针失效、结论悬置', () => {
    const ds = makeDataset([
      {}, {}, {}, {}, {},
      { drop: { from: 32 * 60_000, to: 34 * 60_000 } },
    ]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    expect(p6.longGaps.length).toBeGreaterThan(0);
    expect(p6.findings.some((f) => f.code === 'long-gap' && f.severity === 'block')).toBe(true);
    expect(p6.phases.hold?.blocked).toBe(true);
    expect(p6.eligible).toBe(false);
    expect(a.verdict).toBe('indeterminate');
    expect(a.coldPointId).not.toBe('p6');
  });

  it('长缺口证据信息明确禁止补零/沿用，且缺口宽度被记录', () => {
    const samples = [
      ...flatSamples([0, 30], 120),
      { t: 60_000, temp: null },
      { t: 90_000, temp: null },
      ...flatSamples([150, 180], 120),
    ];
    const built = buildSegments(samples, 60_000);
    // 30s→150s 跨度 120s 超过允许 60s
    expect(built.longGaps).toHaveLength(1);
    expect(built.longGaps[0]).toEqual({ from: 30_000, to: 150_000 });
    // 缺口内绝不构造任何线段（无补零、无 hold-last 水平线）
    expect(built.segments.every((s) => !(s.t1 < 150_000 && s.t2 > 30_000 && s.t2 - s.t1 > 60_000))).toBe(true);
  });

  it('短缺测允许插值但保留 warn 证据，探针仍有效', () => {
    const ds = makeDataset([{}, {}, {}, {}, { drop: { from: 35 * 60_000, to: 35 * 60_000 + 25_000 } }, {}]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p5 = a.channels.find((c) => c.id === 'p5')!;
    const shortGaps = p5.findings.filter((f) => f.code === 'short-gap');
    expect(shortGaps.length).toBeGreaterThan(0);
    expect(shortGaps.every((f) => f.severity === 'warn')).toBe(true);
    expect(p5.findings.some((f) => f.code === 'long-gap')).toBe(false);
    expect(p5.eligible).toBe(true);
  });

  it('时间倒退：记录 block 证据，该通道不参与放行', () => {
    const ds = makeDataset([{}, {}, { regressAtStep: 100 }, {}, {}, {}]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p3 = a.channels.find((c) => c.id === 'p3')!;
    expect(p3.findings.some((f) => f.code === 'time-regression' && f.severity === 'block')).toBe(true);
    expect(p3.eligible).toBe(false);
    expect(a.verdict).toBe('indeterminate');
  });

  it('阶段覆盖不完整（提前结束采集）阻止降温与整体结论', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { stopAt: 40 * 60_000 }]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    expect(p6.phases.hold?.blocked).toBe(true);
    expect(p6.phases.cool?.blocked).toBe(true);
    expect(p6.findings.some((f) => f.code === 'coverage' && f.phase === 'cool')).toBe(true);
    expect(p6.eligible).toBe(false);
    expect(a.verdict).toBe('indeterminate');
  });

  it('升温段迟到（起点无覆盖）阻止升温贡献', () => {
    const ds = makeDataset([{ shiftMs: 5 * 60_000 }, {}, {}, {}, {}, {}]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p1 = a.channels.find((c) => c.id === 'p1')!;
    expect(p1.phases.comeUp?.blocked).toBe(true);
    expect(p1.findings.some((f) => f.code === 'coverage' && f.phase === 'comeUp')).toBe(true);
  });
});
