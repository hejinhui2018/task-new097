import { describe, it, expect, beforeEach } from 'vitest';
import { reducer, initState, DEFAULT_SETTINGS } from '../lib/state';
import { persistState, loadPersisted, clearPersisted } from '../lib/storage';
import { analyze } from '../lib/analyze';
import { buildSampleDataset, SAMPLE_STAGE } from '../lib/sampleData';

function sampleInit() {
  const settings = {
    ...DEFAULT_SETTINGS,
    holdStart: SAMPLE_STAGE.holdStart,
    holdEnd: SAMPLE_STAGE.holdEnd,
  };
  return initState(buildSampleDataset(), settings);
}

describe('撤销 / 重做历史', () => {
  it('提交形成历史，撤销恢复上一状态，重做前进', () => {
    let s = sampleInit();
    const beforeAdj = JSON.stringify(s.adjustments);
    s = reducer(s, {
      type: 'commit',
      label: '停用 P6',
      patch: { adjustments: { offsets: {}, disabled: { 'probe-6': true } } },
    });
    expect(s.adjustments.disabled['probe-6']).toBe(true);
    expect(s.future).toHaveLength(0);

    s = reducer(s, { type: 'undo' });
    expect(JSON.stringify(s.adjustments)).toBe(beforeAdj);
    expect(s.future.length).toBe(1);
    expect(s.lastLabel).toContain('停用 P6');

    s = reducer(s, { type: 'redo' });
    expect(s.adjustments.disabled['probe-6']).toBe(true);
    expect(s.future).toHaveLength(0);
  });

  it('新提交清空重做分支', () => {
    let s = sampleInit();
    s = reducer(s, { type: 'commit', label: 'a', patch: { adjustments: { offsets: { 'probe-1': 1000 }, disabled: {} } } });
    s = reducer(s, { type: 'undo' });
    expect(s.future.length).toBe(1);
    s = reducer(s, { type: 'commit', label: 'b', patch: { adjustments: { offsets: { 'probe-1': 2000 }, disabled: {} } } });
    expect(s.future).toHaveLength(0);
    expect(s.adjustments.offsets['probe-1']).toBe(2000);
  });

  it('连续撤销可回到最初的参数与阶段设置', () => {
    let s = sampleInit();
    const initialTarget = s.settings.targetF0;
    s = reducer(s, { type: 'commit', label: '改目标', patch: { settings: { ...s.settings, targetF0: 12 } } });
    s = reducer(s, { type: 'commit', label: '再改目标', patch: { settings: { ...s.settings, targetF0: 20 } } });
    s = reducer(s, { type: 'undo' });
    expect(s.settings.targetF0).toBe(12);
    s = reducer(s, { type: 'undo' });
    expect(s.settings.targetF0).toBe(initialTarget);
  });
});

describe('本地保存与刷新恢复', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('保存后可完整恢复数据集、设置、调整与撤销栈', () => {
    let s = sampleInit();
    s = reducer(s, {
      type: 'commit',
      label: '停用 P6',
      patch: { adjustments: { offsets: {}, disabled: { 'probe-6': true } } },
    });
    expect(persistState(s)).toBe(true);

    const p = loadPersisted();
    expect(p).not.toBeNull();
    expect(p!.dataset.channels).toHaveLength(7);
    expect(p!.adjustments.disabled['probe-6']).toBe(true);
    expect(p!.past.length).toBe(1);

    const restored = reducer(initState(buildSampleDataset()), { type: 'hydrate', state: p! });
    expect(restored.adjustments.disabled['probe-6']).toBe(true);
    expect(restored.settings.holdStart).toBe(SAMPLE_STAGE.holdStart);
    // 恢复后仍可撤销，回到停用前
    const undone = reducer(restored, { type: 'undo' });
    expect(undone.adjustments.disabled['probe-6']).toBeUndefined();
  });

  it('内置示例：P6 漂移阻止放行，停用并恢复后判定一致', () => {
    const s = sampleInit();
    const a1 = analyze(s.dataset, s.settings, s.adjustments);
    expect(a1.channels.find((c) => c.id === 'probe-6')!.findings.some((f) => f.code === 'drift' && f.severity === 'block')).toBe(true);

    const s2 = reducer(s, {
      type: 'commit',
      label: '停用 P6',
      patch: { adjustments: { offsets: {}, disabled: { 'probe-6': true } } },
    });
    persistState(s2);
    const restored = reducer(initState(buildSampleDataset()), { type: 'hydrate', state: loadPersisted()! });
    const a2 = analyze(restored.dataset, restored.settings, restored.adjustments);
    expect(a2.verdict).toBe('pass');

    const undone = reducer(restored, { type: 'undo' });
    const a3 = analyze(undone.dataset, undone.settings, undone.adjustments);
    expect(a3.verdict).toBe(a1.verdict);
  });

  it('损坏的本地数据被安全忽略', () => {
    localStorage.setItem('hpr-review-state-v1', '{not json');
    expect(loadPersisted()).toBeNull();
    clearPersisted();
    expect(loadPersisted()).toBeNull();
  });
});
