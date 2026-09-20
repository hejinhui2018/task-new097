import type { BatchResult, Defect } from "../types";

export function EvidencePanel(props: { result: BatchResult }) {
  const { result } = props;
  const all: { name: string; d: Defect }[] = [];
  for (const a of [result.retort, ...result.probes]) {
    if (!a) continue;
    for (const d of a.defects) all.push({ name: a.name, d });
  }
  all.sort((x, y) => (x.d.severity === y.d.severity ? 0 : x.d.severity === "block" ? -1 : 1));
  return (
    <div className="evidence">
      {all.length === 0 ? (
        <div className="note">未发现时间轴、缺测或漂移异常。阶段覆盖完整，允许内的短缺测已按真实时间轴插值计入。</div>
      ) : (
        <ul>
          {all.map(({ name, d }, i) => (
            <li key={i}>
              <span className={`sev ${d.severity}`}>{d.severity === "block" ? "阻断" : "警告"}</span>
              <span>{d.message.replace(`${name}：`, "")}</span>
              <span className="tag">{name}</span>
            </li>
          ))}
        </ul>
      )}
      {result.reasons.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--grid)" }}>
          <div className="note" style={{ marginBottom: 3 }}>结论依据</div>
          <ul>
            {result.reasons.map((r, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--ink-2)" }}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
