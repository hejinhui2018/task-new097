import type { Analysis, ChannelResult } from '../types';
import { fmtF } from '../lib/render';

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

export function probeSlot(id: string, channels: ChannelResult[]): number {
  const i = channels.filter((c) => c.kind === 'probe').findIndex((c) => c.id === id);
  return Math.max(0, i % 6);
}

export function colorVar(ch: ChannelResult, channels: ChannelResult[]): string {
  if (ch.kind === 'retort') return 'var(--retort)';
  return `var(${SERIES[probeSlot(ch.id, channels)]})`;
}

export function Ranking({
  analysis,
  targetF0,
  selectedId,
  onSelect,
}: {
  analysis: Analysis;
  targetF0: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const probes = analysis.channels
    .filter((c) => c.kind === 'probe')
    .sort((a, b) => b.totalF - a.totalF);
  const maxF = Math.max(...probes.map((p) => p.totalF), targetF0);

  const statusChip = (c: ChannelResult) => {
    if (c.disabled) return <span className="chip muted">已停用</span>;
    if (!c.eligible) return <span className="chip block">门禁阻止</span>;
    if (c.totalF >= targetF0) return <span className="chip good">达标</span>;
    return <span className="chip block">F0 不足</span>;
  };

  return (
    <table className="rank">
      <thead>
        <tr>
          <th>探针</th>
          <th style={{ width: 108 }}>累计 F0</th>
          <th style={{ width: 52 }}>升温</th>
          <th style={{ width: 52 }}>保温</th>
          <th style={{ width: 52 }}>降温</th>
          <th style={{ width: 76 }}>状态</th>
        </tr>
      </thead>
      <tbody>
        {probes.map((c) => {
          const isCold = c.id === analysis.coldPointId;
          const width = Math.max(2, (c.totalF / maxF) * 100);
          const fill = isCold ? 'var(--critical)' : c.eligible ? colorVar(c, analysis.channels) : 'var(--muted)';
          return (
            <tr
              key={c.id}
              className={`row${selectedId === c.id ? ' selected' : ''}${c.disabled ? ' dimmed' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <td>
                <span className="dot" style={{ background: colorVar(c, analysis.channels) }} />
                {c.name}
                {isCold && <span className="chip block" style={{ marginLeft: 6 }}>冷点</span>}
              </td>
              <td className="bar-cell">
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${width}%`, background: fill }} />
                </span>
                <span className="bar-num" style={{ display: 'block', color: 'var(--ink)' }}>{fmtF(c.totalF)}</span>
              </td>
              <td>{fmtF(c.phases.comeUp?.f ?? null)}</td>
              <td>{fmtF(c.phases.hold?.f ?? null)}</td>
              <td>{fmtF(c.phases.cool?.f ?? null)}</td>
              <td>{statusChip(c)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PhaseLegend() {
  return (
    <div className="hint" style={{ marginTop: 6 }}>
      升温贡献、保温贡献、降温贡献三段之和 = 全过程累计 F0；被门禁阻止的阶段数字不可用于放行。
    </div>
  );
}
