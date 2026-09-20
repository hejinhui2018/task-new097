import type { BatchResult, StageDef } from "../types";
import { tokens } from "../theme";
import { fmtF } from "../format";

const STAGE_COLOR: Record<string, string> = {
  comeup: "#eb6834",
  holding: "#2a78d6",
  cooling: "#1baf7a",
};

const STAGE_NAME: Record<string, string> = { comeup: "升温", holding: "保温", cooling: "降温" };

export function ProbeRanking(props: {
  result: BatchResult;
  stages: StageDef[];
  theme: "light" | "dark";
  hidden: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { result, stages, theme, hidden, onToggle } = props;
  const tk = tokens(theme);
  const ordered = [...result.probes].sort((a, b) => {
    if (a.totalF === null && b.totalF === null) return a.name.localeCompare(b.name);
    if (a.totalF === null) return 1;
    if (b.totalF === null) return -1;
    return a.totalF - b.totalF;
  });
  return (
    <div>
      <div className="note" style={{ marginBottom: 6 }}>
        按累计 F0 升序；首个有效探针即本批冷点。阻断探针不参与冷点与放行。
      </div>
      {ordered.map((p) => {
        const realIdx = result.probes.findIndex((x) => x.id === p.id);
        const hex = tk.series[realIdx] ?? tk.retort;
        const isCp = result.coldPoint?.id === p.id;
        const contribs = stages.map((s) => p.stageF[s.id]?.f ?? 0);
        const totalC = contribs.reduce((a, b) => a + b, 0) || 1;
        return (
          <div key={p.id} className={`rank-row${p.valid ? "" : " invalid"}`}>
            <span
              className="swatch"
              style={{ background: hex, cursor: "pointer", opacity: hidden.has(p.id) ? 0.3 : 1 }}
              onClick={() => onToggle(p.id)}
              title={hidden.has(p.id) ? "显示该探针" : "隐藏该探针"}
            />
            <div>
              <div className="name">
                <span onClick={() => onToggle(p.id)} style={{ cursor: "pointer" }}>{p.name}</span>
                {isCp && <span className="cp-badge">冷点</span>}
                {!p.valid && <span className="sev block" style={{ marginLeft: 6, fontSize: 9, padding: "0 4px" }}>阻断</span>}
                <span className="f" style={{ float: "right" }}>
                  {p.totalF === null ? "F0 不出数" : `${fmtF(p.totalF)} min`}
                </span>
              </div>
              <div className="stagebar" title={stages.map((s, i) => `${s.name} ${fmtF(contribs[i])} min${p.stageF[s.id]?.complete ? "" : "（不完整）"}`).join("　")}>
                {stages.map((s, i) =>
                  contribs[i] > 0 ? (
                    <i key={s.id} style={{ width: `${(contribs[i] / totalC) * 100}%`, background: STAGE_COLOR[s.kind] }} />
                  ) : null,
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }} className="note">
        {(["comeup", "holding", "cooling"] as const).map((k) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: STAGE_COLOR[k], display: "inline-block" }} />
            {STAGE_NAME[k]}贡献
          </span>
        ))}
      </div>
    </div>
  );
}

export function FTargetBar(props: { result: BatchResult; target: number }) {
  const cp = props.result.coldPoint;
  if (!cp) return null;
  const pct = Math.min(1, cp.f / props.target);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="note" style={{ marginBottom: 3 }}>
        冷点 F0 相对目标 {props.target} min：{fmtF(cp.f)} / {props.target}（{Math.round(pct * 100)}%）
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "var(--surface-2)", overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: pct >= 1 ? "var(--good)" : "var(--critical)" }} />
      </div>
    </div>
  );
}
