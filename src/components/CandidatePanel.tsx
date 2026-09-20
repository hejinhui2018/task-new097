import type { BatchResult, AdjustmentMap } from "../types";
import type { AdjustCandidate } from "../lib/analyze";

export function CandidatePanel(props: {
  candidates: AdjustCandidate[];
  adjustments: AdjustmentMap;
  trial: AdjustmentMap | null;
  trialResult: BatchResult | null;
  baseResult: BatchResult;
  target: number;
  onTrial: (cand: AdjustCandidate) => void;
  onClearTrial: () => void;
  onAdopt: () => void;
  onRemove: (channelId: string) => void;
}) {
  const { candidates, adjustments, trial, trialResult, baseResult, target, onTrial, onClearTrial, onAdopt, onRemove } = props;
  const adopted = Object.entries(adjustments).filter(([, a]) => a.disabled || a.offsetSeconds);
  return (
    <div>
      {candidates.length === 0 && adopted.length === 0 && (
        <div className="note">当前未发现需要校时或停用的探针。校时/停用只作为候选比较，须人工确认后采用。</div>
      )}

      {candidates.map((c, i) => (
        <div key={`${c.channelId}-${c.kind}-${i}`} className="candidate">
          <div>
            <strong>{c.channelName}</strong>{" "}
            <span className="tag">{c.kind === "timeshift" ? `校时 ${c.offsetSeconds! > 0 ? "+" : ""}${c.offsetSeconds}s` : "停用探针"}</span>
          </div>
          <div className="why">{c.rationale}</div>
          <div className="actions">
            <button className="tiny" onClick={() => onTrial(c)}>作为候选比较</button>
            {trial?.[c.channelId] && (
              <>
                <button className="tiny primary" onClick={onAdopt}>采用并刷新</button>
                <button className="tiny" onClick={onClearTrial}>放弃候选</button>
              </>
            )}
          </div>
        </div>
      ))}

      {trial && trialResult && (
        <div className="trial-box">
          <div style={{ fontWeight: 600, marginBottom: 3 }}>候选比较（尚未生效）</div>
          <Compare before={baseResult} after={trialResult} target={target} />
        </div>
      )}

      {adopted.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="note" style={{ marginBottom: 4 }}>已采用（可撤销恢复原始数据）：</div>
          <ul className="plain">
            {adopted.map(([id, a]) => (
              <li key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "3px 0", fontSize: 12 }}>
                <span>
                  {id}：{a.disabled ? "已停用" : `校时 ${a.offsetSeconds! > 0 ? "+" : ""}${a.offsetSeconds}s`}
                </span>
                <button className="tiny" onClick={() => onRemove(id)}>撤销此项</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Compare(props: { before: BatchResult; after: BatchResult; target: number }) {
  const { before, after, target } = props;
  const cp = (r: BatchResult) => (r.coldPoint ? `${r.coldPoint.name} ${r.coldPoint.f.toFixed(2)}` : "无有效冷点");
  const verdictText: Record<string, string> = { pass: "通过", conditional: "条件通过", hold: "不予放行", block: "阻断" };
  return (
    <table className="cursor-table">
      <thead>
        <tr><th></th><th>当前</th><th>候选</th></tr>
      </thead>
      <tbody>
        <tr><td style={{ textAlign: "left" }}>结论</td><td>{verdictText[before.verdict]}</td><td>{verdictText[after.verdict]}</td></tr>
        <tr><td style={{ textAlign: "left" }}>冷点 F0</td><td>{cp(before)}</td><td>{cp(after)}</td></tr>
        <tr><td style={{ textAlign: "left" }}>有效探针</td><td>{before.probes.filter((p) => p.valid).length}/{before.probes.length}</td><td>{after.probes.filter((p) => p.valid).length}/{after.probes.length}</td></tr>
        <tr><td style={{ textAlign: "left" }}>目标 F0</td><td colSpan={2}>{target} min（停用探针的罐位视为未验证，候选不能增加其安全裕度）</td></tr>
      </tbody>
    </table>
  );
}
