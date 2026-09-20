import { useMemo, useState } from 'react';
import type { Adjustments, Analysis, ChannelResult, Dataset, Settings } from '../types';
import { compareCandidate } from '../lib/stages';
import type { CandidateSpec } from '../lib/stages';
import { fmtClock } from '../lib/analyze';

const VERDICT_TEXT: Record<Analysis['verdict'], string> = {
  pass: '可放行',
  fail: 'F0 不足',
  indeterminate: '结论悬置',
};

function verdictColor(v: Analysis['verdict']): string {
  return v === 'pass' ? 'var(--good-text)' : v === 'fail' ? 'var(--critical)' : 'var(--serious)';
}

interface Pending {
  spec: CandidateSpec;
  cmp: ReturnType<typeof compareCandidate>;
}

export function Candidates({
  analysis,
  dataset,
  settings,
  adjustments,
  onAdopt,
}: {
  analysis: Analysis;
  dataset: Dataset;
  settings: Settings;
  adjustments: Adjustments;
  onAdopt: (label: string, next: Adjustments) => void;
}) {
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [manualOffset, setManualOffset] = useState<Record<string, string>>({});

  const probes = analysis.channels.filter((c) => c.kind === 'probe');

  const buildCandidate = (spec: CandidateSpec): Pending => {
    const cmp = compareCandidate(dataset, settings, adjustments, spec);
    return { spec, cmp };
  };

  const suggestions = useMemo(() => {
    return probes
      .map((ch) => {
        const items: { spec: CandidateSpec; reason: string }[] = [];
        if (ch.suggestedOffset !== null && (adjustments.offsets[ch.id] ?? 0) !== ch.suggestedOffset) {
          const sec = Math.round(ch.suggestedOffset / 1000);
          items.push({
            spec: { kind: 'offset', channelId: ch.id, offsetMs: ch.suggestedOffset, label: `校时 ${ch.name} ${sec > 0 ? '+' : ''}${sec}s` },
            reason: `升温曲线相对其余探针整体${sec > 0 ? '滞后' : '超前'} ${Math.abs(sec)} s（影子对齐建议）`,
          });
        }
        if (!ch.eligible && !ch.disabled) {
          const blocked = ch.findings.some((f) => f.severity === 'block');
          if (blocked) {
            items.push({
              spec: { kind: 'disable', channelId: ch.id, label: `停用 ${ch.name}` },
              reason: '该探针存在 block 级证据；若确认与罐内杀菌强度无关（如传感器故障），可人工停用',
            });
          }
        }
        if (ch.disabled) {
          items.push({
            spec: { kind: 'enable', channelId: ch.id, label: `重新启用 ${ch.name}` },
            reason: '当前已停用，不参与冷点判定',
          });
        }
        if ((adjustments.offsets[ch.id] ?? 0) !== 0) {
          items.push({
            spec: { kind: 'clearOffset', channelId: ch.id, label: `清除 ${ch.name} 校时` },
            reason: `当前已应用校时 ${Math.round((adjustments.offsets[ch.id] ?? 0) / 1000)} s`,
          });
        }
        return { ch, items };
      })
      .filter((x) => x.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, dataset, settings, adjustments]);

  const adopt = (p: Pending) => {
    const next: Adjustments = {
      offsets: { ...adjustments.offsets },
      disabled: { ...adjustments.disabled },
    };
    const ch = p.spec.channelId;
    if (p.spec.kind === 'offset') next.offsets[ch] = Math.round(p.spec.offsetMs ?? 0);
    if (p.spec.kind === 'clearOffset') delete next.offsets[ch];
    if (p.spec.kind === 'disable') next.disabled[ch] = true;
    if (p.spec.kind === 'enable') delete next.disabled[ch];
    onAdopt(p.spec.label, next);
    const rest = { ...pending };
    delete rest[ch];
    setPending(rest);
  };

  const previewManual = (ch: ChannelResult) => {
    const sec = Number(manualOffset[ch.id]);
    if (!Number.isFinite(sec)) return;
    const spec: CandidateSpec = {
      kind: 'offset',
      channelId: ch.id,
      offsetMs: Math.round(sec * 1000),
      label: `校时 ${ch.name} ${sec > 0 ? '+' : ''}${sec}s`,
    };
    setPending({ ...pending, [ch.id]: buildCandidate(spec) });
  };

  if (suggestions.length === 0) {
    return <div className="none-good">● 当前没有待处理候选：探针既无校时建议，也无需要停用的被阻止通道。</div>;
  }

  return (
    <div>
      {suggestions.map(({ ch, items }) => {
        const pend = pending[ch.id];
        return (
          <div className="cand" key={ch.id}>
            <div className="head">
              <span className="name">{ch.name}</span>
              {items.map((it) => (
                <span className="chip muted" key={it.spec.kind}>
                  {it.reason}
                </span>
              ))}
            </div>
            <div className="actions">
              {items.map((it) => (
                <button
                  key={it.spec.kind}
                  className="btn tiny"
                  onClick={() =>
                    setPending({
                      ...pending,
                      [ch.id]: buildCandidate(it.spec),
                    })
                  }
                >
                  候选：{it.spec.label}
                </button>
              ))}
              <span className="hint">
                或手动校时
                <input
                  className="off"
                  style={{ margin: '0 4px 0 6px' }}
                  type="number"
                  step="1"
                  placeholder="秒"
                  value={manualOffset[ch.id] ?? ''}
                  onChange={(e) => setManualOffset({ ...manualOffset, [ch.id]: e.target.value })}
                />
                <button className="btn tiny" onClick={() => previewManual(ch)}>
                  预览
                </button>
              </span>
            </div>
            {pend && (
              <div className="cmp-box">
                <div>
                  现状：<b style={{ color: verdictColor(pend.cmp.before.verdict) }}>{VERDICT_TEXT[pend.cmp.before.verdict]}</b>
                  {'  '}· 冷点 {nameOf(analysis, pend.cmp.before.coldPointId)} · {ch.name} F0 {pend.cmp.before.channel.totalF.toFixed(2)} ·{' '}
                  {pend.cmp.before.channel.eligible ? '有效' : '无效'}
                </div>
                <div>
                  候选后：<b style={{ color: verdictColor(pend.cmp.after.verdict) }}>{VERDICT_TEXT[pend.cmp.after.verdict]}</b>
                  {'  '}· 冷点 {nameOf(analysis, pend.cmp.after.coldPointId)} · {ch.name} F0 {pend.cmp.after.channel.totalF.toFixed(2)} ·{' '}
                  {pend.cmp.after.channel.eligible ? '有效' : '无效'}
                  {pend.cmp.after.channel.offsetApplied !== 0 && (
                    <> · 时间轴平移 {Math.round(pend.cmp.after.channel.offsetApplied / 1000)} s（{fmtClock(pend.cmp.after.channel.firstT ?? 0)} 起）</>
                  )}
                </div>
                <div className="actions" style={{ marginTop: 7 }}>
                  <button className="btn tiny primary" onClick={() => adopt(pend)}>
                    采用该候选（可撤销）
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() => {
                      const rest = { ...pending };
                      delete rest[ch.id];
                      setPending(rest);
                    }}
                  >
                    放弃比较
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function nameOf(analysis: Analysis, id: string | null): string {
  if (!id) return '—';
  return analysis.channels.find((c) => c.id === id)?.name ?? id;
}
