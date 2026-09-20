import { describe, it, expect } from 'vitest';
import { analyze } from '../lib/analyze';
import { compareCandidate } from '../lib/stages';
import { makeDataset, makeSettings } from './fixtures';
import { EMPTY_ADJUSTMENTS } from '../lib/state';

describe('漂移门禁与校时/停用候选', () => {
  it('保温段持续偏冷超过阈值：block 级 drift，探针失效，结论悬置', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { driftCold: 2.6 }]);
    const a = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    const f = p6.findings.find((x) => x.code === 'drift');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('block');
    expect(f!.value!).toBeLessThan(-1.5);
    expect(p6.driftResidual!).toBeLessThan(-1.5);
    expect(p6.eligible).toBe(false);
    expect(a.verdict).toBe('indeterminate');
  });

  it('偏差在阈值的 60%~100% 之间只给 warn，探针仍有效', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { driftCold: 1.2 }]);
    const a = analyze(ds, makeSettings({ driftC: 1.5 }), EMPTY_ADJUSTMENTS);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    const f = p6.findings.find((x) => x.code === 'drift');
    expect(f?.severity).toBe('warn');
    expect(p6.eligible).toBe(true);
  });

  it('停用候选：影子分析不改变现状，采用后漂移探针被剔除、其余可放行，撤销后恢复', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { driftCold: 2.6 }]);
    const settings = makeSettings();
    const before = analyze(ds, settings, EMPTY_ADJUSTMENTS);
    expect(before.verdict).toBe('indeterminate');

    const cmp = compareCandidate(ds, settings, EMPTY_ADJUSTMENTS, {
      kind: 'disable',
      channelId: 'p6',
      label: '停用 P6（候选）',
    });
    // 候选比较不改动基线
    expect(cmp.before.verdict).toBe('indeterminate');
    expect(cmp.before.channel.disabled).toBe(false);
    expect(cmp.after.channel.disabled).toBe(true);
    expect(cmp.after.channel.eligible).toBe(false);
    expect(cmp.after.verdict).toBe('pass');
    expect(cmp.after.coldPointId).not.toBe('p6');

    // “采用”候选后的真实分析
    const adopted = analyze(ds, settings, { offsets: {}, disabled: { p6: true } });
    expect(adopted.verdict).toBe('pass');
    // 撤销 = 恢复基线
    const undone = analyze(ds, settings, EMPTY_ADJUSTMENTS);
    expect(undone.verdict).toBe('indeterminate');
  });

  it('时钟错位：给出 clock-jump 证据与校时候选，采用后通道回到正确时间轴', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { shiftMs: 60_000 }]);
    const settings = makeSettings();
    const a = analyze(ds, settings, EMPTY_ADJUSTMENTS);
    const p6 = a.channels.find((c) => c.id === 'p6')!;
    expect(p6.findings.some((f) => f.code === 'clock-jump')).toBe(true);
    // 读数被整体推后 60s，建议偏移约 -60s（容差一个搜索步长）
    expect(p6.suggestedOffset).not.toBeNull();
    expect(Math.abs(p6.suggestedOffset! + 60_000)).toBeLessThanOrEqual(30_000);

    const cmp = compareCandidate(ds, settings, EMPTY_ADJUSTMENTS, {
      kind: 'offset',
      channelId: 'p6',
      offsetMs: p6.suggestedOffset!,
      label: '校时 P6（候选）',
    });
    expect(cmp.after.channel.offsetApplied).toBe(p6.suggestedOffset);
    // 校后首个有效读数回到过程起点附近
    expect(Math.abs(cmp.after.channel.firstT!)).toBeLessThanOrEqual(5_000);
    expect(cmp.after.channel.eligible).toBe(true);
  });

  it('校时候选与现状并列比较，原始数据始终不被改写', () => {
    const ds = makeDataset([{}, {}, {}, {}, {}, { shiftMs: 60_000 }]);
    const rawFirst = ds.channels.find((c) => c.id === 'p6')!.samples[5].t;
    compareCandidate(ds, makeSettings(), EMPTY_ADJUSTMENTS, {
      kind: 'offset',
      channelId: 'p6',
      offsetMs: -60_000,
      label: '校时 P6（候选）',
    });
    expect(ds.channels.find((c) => c.id === 'p6')!.samples[5].t).toBe(rawFirst);
    // 未采用时基线偏移仍为 0
    const base = analyze(ds, makeSettings(), EMPTY_ADJUSTMENTS);
    expect(base.channels.find((c) => c.id === 'p6')!.offsetApplied).toBe(0);
  });
});
