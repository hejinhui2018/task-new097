import { describe, it, expect } from 'vitest';
import { analyze } from '../lib/analyze';
import { makeDataset, makeSettings } from './fixtures';
import { EMPTY_ADJUSTMENTS } from '../lib/state';

describe('冷点识别', () => {
  it('冷点 = 有效探针中全过程累计 F0 最低者', () => {
    const a = analyze(makeDataset(), makeSettings(), EMPTY_ADJUSTMENTS);
    expect(a.verdict).toBe('pass');
    const probes = a.channels.filter((c) => c.kind === 'probe' && c.eligible);
    const minId = probes.reduce((m, c) => (c.totalF < m.totalF ? c : m)).id;
    expect(a.coldPointId).toBe(minId);
  });

  it('F0 更低的探针被门禁阻止时，冷点在其余有效探针中重选', () => {
    // 正常最冷的探针被注入保温长缺口 → 失效，冷点移交给次低有效探针
    const ds = makeDataset([{}, {}, {}, {}, {}, { drop: { from: 30 * 60_000, to: 33 * 60_000 } }]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const bad = a.channels.find((c) => c.id === 'p6')!;
    expect(bad.eligible).toBe(false);
    expect(a.verdict).toBe('indeterminate');
    const eligible = a.channels.filter((c) => c.kind === 'probe' && c.eligible);
    if (eligible.length > 0) {
      const minId = eligible.reduce((m, c) => (c.totalF < m.totalF ? c : m)).id;
      expect(a.coldPointId).toBe(minId);
    }
  });

  it('全部探针失效时无冷点且结论悬置', () => {
    const ds = makeDataset([
      { stopAt: 40 * 60_000 },
      { stopAt: 40 * 60_000 },
      { regressAtStep: 50 },
      { drop: { from: 30 * 60_000, to: 34 * 60_000 } },
      { drop: { from: 30 * 60_000, to: 34 * 60_000 } },
      { stopAt: 40 * 60_000 },
    ]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    expect(a.coldPointId).toBeNull();
    expect(a.verdict).toBe('indeterminate');
  });

  it('探针 F0 达标的放行判定', () => {
    const a = analyze(makeDataset(), makeSettings({ targetF0: 6 }), EMPTY_ADJUSTMENTS);
    expect(a.verdict).toBe('pass');
    const cold = a.channels.find((c) => c.id === a.coldPointId)!;
    expect(cold.totalF).toBeGreaterThanOrEqual(6);
  });

  it('提高目标 F0 使冷点不达标时判定 fail（数据有效，只是杀菌强度不足）', () => {
    const a = analyze(makeDataset(), makeSettings({ targetF0: 100 }), EMPTY_ADJUSTMENTS);
    expect(a.verdict).toBe('fail');
  });

  it('停用探针不参与冷点判定，但其余探针可形成结论', () => {
    const adj = { offsets: {}, disabled: { p6: true } };
    const a = analyze(makeDataset([{}, {}, {}, {}, {}, { driftCold: 3 }]), makeSettings(), adj);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    expect(p6.disabled).toBe(true);
    expect(p6.eligible).toBe(false);
    expect(a.verdict).not.toBe('indeterminate');
    expect(a.coldPointId).not.toBe('p6');
    expect(a.verdictReasons.some((r) => r.includes('停用'))).toBe(true);
  });
});
