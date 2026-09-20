import { describe, it, expect } from 'vitest';
import { analyze } from '../lib/analyze';
import { makeDataset, makeSettings, CAME_UP, HOLD, END } from './fixtures';
import { EMPTY_ADJUSTMENTS } from '../lib/state';

describe('工艺阶段边界归因', () => {
  it('升温/保温/降温三段之和等于全过程累计 F0', () => {
    const a = analyze(makeDataset(), makeSettings(), EMPTY_ADJUSTMENTS);
    for (const ch of a.channels) {
      const sum =
        (ch.phases.comeUp?.f ?? 0) + (ch.phases.hold?.f ?? 0) + (ch.phases.cool?.f ?? 0);
      expect(sum).toBeCloseTo(ch.totalF, 9);
      expect(ch.phases.comeUp?.blocked).toBe(false);
      expect(ch.phases.hold?.blocked).toBe(false);
      expect(ch.phases.cool?.blocked).toBe(false);
    }
  });

  it('阶段边界恰好落在保温开始/结束时刻，边界点不重复计入', () => {
    const a = analyze(makeDataset(), makeSettings(), EMPTY_ADJUSTMENTS);
    expect(a.holdStart).toBe(CAME_UP);
    expect(a.holdEnd).toBe(HOLD);
    for (const ch of a.channels) {
      expect(ch.phases.comeUp!.end).toBe(CAME_UP);
      expect(ch.phases.hold!.start).toBe(CAME_UP);
      expect(ch.phases.hold!.end).toBe(HOLD);
      expect(ch.phases.cool!.start).toBe(HOLD);
      expect(ch.phases.comeUp!.start).toBe(a.windowStart);
      expect(ch.phases.cool!.end).toBe(a.windowEnd);
    }
  });

  it('保温段贡献为主要致死来源，升温与降温贡献为正', () => {
    const a = analyze(makeDataset(), makeSettings(), EMPTY_ADJUSTMENTS);
    for (const ch of a.channels.filter((c) => c.kind === 'probe')) {
      const cu = ch.phases.comeUp!.f;
      const hold = ch.phases.hold!.f;
      const cool = ch.phases.cool!.f;
      expect(hold).toBeGreaterThan(cu);
      expect(hold).toBeGreaterThan(cool);
      expect(cu).toBeGreaterThan(0);
      expect(cool).toBeGreaterThanOrEqual(0);
    }
  });

  it('未设定保温边界时整体结论被阻止（no-stages）', () => {
    const a = analyze(makeDataset(), makeSettings({ holdStart: null, holdEnd: null }), EMPTY_ADJUSTMENTS);
    expect(a.verdict).toBe('indeterminate');
    expect(a.findings.some((f) => f.code === 'no-stages')).toBe(true);
    expect(a.coldPointId).toBeNull();
    for (const ch of a.channels) expect(ch.eligible).toBe(false);
  });

  it('结束时间早于开始时间视为未设定', () => {
    const a = analyze(makeDataset(), makeSettings({ holdStart: HOLD, holdEnd: CAME_UP }), EMPTY_ADJUSTMENTS);
    expect(a.verdict).toBe('indeterminate');
    expect(a.findings.some((f) => f.code === 'no-stages')).toBe(true);
  });

  it('全过程总窗延伸至降温结束附近（受不规则节拍限制，末点在 30 s 内）', () => {
    const a = analyze(makeDataset(), makeSettings(), EMPTY_ADJUSTMENTS);
    expect(Math.abs(a.windowEnd - END)).toBeLessThanOrEqual(30_000);
  });
});
