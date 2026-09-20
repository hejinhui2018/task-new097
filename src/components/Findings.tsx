import type { Analysis, Finding } from '../types';

const SEV_ORDER = { block: 0, warn: 1 } as const;

export function Findings({ analysis }: { analysis: Analysis }) {
  const findings = [...analysis.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  if (findings.length === 0) {
    return <div className="none-good">● 无偏差证据：时间单调、缺口在允许范围内、阶段覆盖完整。</div>;
  }
  return (
    <div className="findings">
      {findings.map((f: Finding, i) => (
        <div key={`${f.code}-${f.channelId ?? 'g'}-${f.from ?? i}`} className={`finding ${f.severity}`}>
          <span className="ico" aria-hidden>
            {f.severity === 'block' ? '⛔' : '⚠'}
          </span>
          <span className="msg">{f.message}</span>
        </div>
      ))}
    </div>
  );
}
