import type { CursorRow } from "../lib/cursor";
import { tokens } from "../theme";
import { fmtF, fmtTemp, fmtTime } from "../format";

export function CursorPanel(props: {
  rows: CursorRow[];
  t: number;
  theme: "light" | "dark";
  probeIndex: (id: string) => number;
}) {
  const { rows, t, theme, probeIndex } = props;
  const tk = tokens(theme);
  const sorted = [...rows].sort((a, b) => b.rate - a.rate);
  return (
    <div>
      <div className="note" style={{ marginBottom: 4 }}>
        游标 {fmtTime(t)}：各通道瞬时致死率 L 与截至该时刻累计 F0（缺测区间不计、不外推）
      </div>
      <table className="cursor-table">
        <thead>
          <tr>
            <th>通道</th>
            <th>温度 ℃</th>
            <th>L min⁻¹</th>
            <th>累计 F0</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const color = r.role === "retort" ? tk.retort : tk.series[probeIndex(r.id)] ?? tk.retort;
            return (
              <tr key={r.id} className={r.inGap ? "ingap" : ""}>
                <td>
                  <span className="dot" style={{ background: color }} />
                  {r.name}
                  {r.inGap && <span className="sev block" style={{ fontSize: 9, padding: "0 4px", marginLeft: 4 }}>缺测</span>}
                </td>
                <td>{fmtTemp(r.temp)}</td>
                <td>{r.rate >= 0.005 ? r.rate.toFixed(3) : r.rate.toExponential(1)}</td>
                <td>{fmtF(r.cumF)}</td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={4} className="note" style={{ textAlign: "center", padding: 8 }}>该时刻无任何通道数据</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
