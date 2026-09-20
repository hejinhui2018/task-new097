import { useEffect, useId, useState } from 'react';
import type { Settings } from '../types';
import { fmtClockShort, parseClock } from '../lib/render';

function NumberField({
  label,
  value,
  step,
  onCommit,
  width,
}: {
  label: string;
  value: number;
  step: number;
  onCommit: (v: number) => void;
  width?: number;
}) {
  const [text, setText] = useState(String(value));
  const id = useId();
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v)) onCommit(v);
    else setText(String(value));
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        style={width ? { width } : undefined}
        type="number"
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function ClockField({
  label,
  absMs,
  baseMs,
  onCommit,
}: {
  label: string;
  absMs: number | null;
  baseMs: number;
  onCommit: (absMs: number | null) => void;
}) {
  const rel = absMs === null ? '' : fmtClockShort(Math.max(0, absMs - baseMs));
  const [text, setText] = useState(rel);
  const id = useId();
  useEffect(() => setText(rel), [rel]);
  const commit = () => {
    const t = text.trim() === '' ? null : parseClock(text);
    if (t === null) {
      setText(rel);
      onCommit(null);
    } else {
      onCommit(baseMs + t);
    }
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}（相对 mm:ss）</label>
      <input
        id={id}
        className="wide"
        value={text}
        placeholder="未设定"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

export function SettingsPanel({
  settings,
  baseMs,
  onPatch,
  onAutoDetect,
}: {
  settings: Settings;
  baseMs: number;
  onPatch: (label: string, patch: Partial<Settings>) => void;
  onAutoDetect: () => void;
}) {
  return (
    <div className="settings-row">
      <NumberField label="参考温度 Tref (°C)" value={settings.refTemp} step={0.1} onCommit={(v) => onPatch('修改参考温度', { refTemp: v })} />
      <NumberField label="z 值 (°C)" value={settings.zValue} step={0.5} onCommit={(v) => onPatch('修改 z 值', { zValue: v })} />
      <NumberField label="目标 F0 (min)" value={settings.targetF0} step={0.5} onCommit={(v) => onPatch('修改目标 F0', { targetF0: v })} />
      <NumberField label="允许缺测 (s)" value={settings.maxGapSeconds} step={5} onCommit={(v) => onPatch('修改允许缺测', { maxGapSeconds: Math.max(1, v) })} />
      <NumberField label="保温判定温度 (°C)" value={settings.holdTemp} step={0.5} onCommit={(v) => onPatch('修改保温判定温度', { holdTemp: v })} />
      <NumberField label="漂移阈值 (°C)" value={settings.driftC} step={0.1} onCommit={(v) => onPatch('修改漂移阈值', { driftC: Math.max(0.1, v) })} />
      <ClockField
        label="保温开始"
        absMs={settings.holdStart}
        baseMs={baseMs}
        onCommit={(t) => onPatch('设定保温开始', { holdStart: t })}
      />
      <ClockField
        label="保温结束"
        absMs={settings.holdEnd}
        baseMs={baseMs}
        onCommit={(t) => onPatch('设定保温结束', { holdEnd: t })}
      />
      <button className="btn" onClick={onAutoDetect} title="按釜温首次持续达到保温判定温度自动识别">
        自动识别保温段
      </button>
      <span className="hint">时间均相对过程起点；阶段未设定时结论被阻止。</span>
    </div>
  );
}
