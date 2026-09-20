import type { Analysis } from '../types';
import { cursorRows, fmtF, fmtRate } from '../lib/render';
import { colorVar } from './Ranking';

export function CursorTable({
  analysis,
  t,
  refTemp,
  zValue,
}: {
  analysis: Analysis;
  t: number | null;
  refTemp: number;
  zValue: number;
}) {
  if (t === null) {
    return <div className="hint">在上方曲线移动指针，查看该时刻各通道温度、瞬时致死率 L 与累计 F0。</div>;
  }
  const rows = cursorRows(analysis.channels, t, refTemp, zValue);
  return (
    <table className="cursor">
      <thead>
        <tr>
          <th>通道</th>
          <th>温度 °C</th>
          <th>瞬时 L (min⁻¹)</th>
          <th>累计 F0 (min)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const ch = analysis.channels.find((c) => c.id === r.id)!;
          return (
            <tr key={r.id} className={r.disabled ? 'dimmed' : ''}>
              <td>
                <span className="dot" style={{ background: colorVar(ch, analysis.channels) }} />
                {r.name}
                {r.kind === 'retort' && <span className="chip muted" style={{ marginLeft: 6 }}>釜温</span>}
              </td>
              <td>{r.temp === null ? '缺测' : r.temp.toFixed(2)}</td>
              <td>{fmtRate(r.rate)}</td>
              <td>{fmtF(r.cumulative)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
