import { useEffect, useState } from "react";
import type { ProcessParams, StageDef } from "../types";
import { stageDefects } from "../lib/analyze";
import { fmtClockInput, parseClockInput } from "../format";

export function ParamsForm(props: { params: ProcessParams; onChange: (p: ProcessParams) => void }) {
  const { params, onChange } = props;
  const num = (key: keyof ProcessParams, step: number, min: number) => (
    <label className="field">
      {labelOf(key)}
      <input
        type="number"
        value={params[key]}
        step={step}
        min={min}
        onChange={(e) => onChange({ ...params, [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="form-row">
      {num("refTemp", 0.1, 0)}
      {num("zValue", 0.1, 0.1)}
      {num("targetF0", 1, 0)}
      {num("maxGapSec", 5, 0)}
      {num("driftBias", 0.1, 0)}
    </div>
  );
}

function labelOf(k: keyof ProcessParams): string {
  return {
    refTemp: "参考温度 Tref ℃",
    zValue: "z 值 ℃",
    targetF0: "目标 F0 min",
    maxGapSec: "允许缺测 s",
    driftBias: "漂移阈值 ℃",
  }[k];
}

const KIND_LABEL: Record<string, string> = { comeup: "升温", holding: "保温", cooling: "降温" };

export function StageEditor(props: {
  stages: StageDef[];
  onCommit: (stages: StageDef[]) => void;
}) {
  const { stages, onCommit } = props;
  const [draft, setDraft] = useState<StageDef[]>(stages);
  useEffect(() => setDraft(stages), [stages]);

  const errors = stageDefects(draft);
  const set = (i: number, key: "start" | "end", raw: string) => {
    const v = parseClockInput(raw);
    if (v === null) return;
    const next = draft.map((s, j) => (j === i ? { ...s, [key]: v } : s));
    setDraft(next);
  };

  return (
    <div>
      {draft.map((s, i) => (
        <div className="stage-row" key={s.id}>
          <span className="stage-tag">{KIND_LABEL[s.kind]}</span>
          <input value={fmtClockInput(s.start)} onChange={(e) => set(i, "start", e.target.value)} onBlur={() => onCommit(draft)} />
          <span className="note">→</span>
          <input value={fmtClockInput(s.end)} onChange={(e) => set(i, "end", e.target.value)} onBlur={() => onCommit(draft)} />
          <span className="note">{Math.max(0, Math.round((s.end - s.start) / 60))} min</span>
        </div>
      ))}
      {errors.length > 0 ? (
        <ul className="plain" style={{ marginTop: 4 }}>
          {errors.map((e, i) => (
            <li key={i} style={{ color: "var(--critical)", fontSize: 11 }}>⛔ {e}——阶段设置无效时整批不出结论</li>
          ))}
        </ul>
      ) : (
        <div className="note" style={{ marginTop: 4 }}>阶段需首尾相接、覆盖升温/保温/降温；修改失焦后生效并入撤销栈</div>
      )}
    </div>
  );
}
