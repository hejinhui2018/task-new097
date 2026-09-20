import type {
  Adjustments,
  Analysis,
  Channel,
  ChannelResult,
  Dataset,
  Finding,
  FindingCode,
  PhaseF,
  PhaseKey,
  RawSample,
  Settings,
} from '../types';
import { buildSegments, integrateWindow, windowHasLongGap } from './segments';
import { driftResidual, suggestClockLag } from './drift';

export const PHASE_LABEL: Record<PhaseKey, string> = {
  comeUp: '升温',
  hold: '保温',
  cool: '降温',
};

function applyOffset(samples: RawSample[], offsetMs: number): RawSample[] {
  return offsetMs === 0 ? samples : samples.map((s) => ({ ...s, t: s.t + offsetMs }));
}

interface Prepared {
  raw: Channel;
  samples: RawSample[];
  offset: number;
  disabled: boolean;
}

function prepare(channels: Channel[], adj: Adjustments): Prepared[] {
  return channels.map((ch) => {
    const offset = adj.offsets[ch.id] ?? 0;
    const disabled = adj.disabled[ch.id] ?? false;
    return { raw: ch, samples: applyOffset(ch.samples, offset), offset, disabled };
  });
}

/**
 * 核心分析。任何受时间倒退、长缺口、阶段覆盖不完整、停用影响的探针都标记为
 * 不可计放行（eligible=false）；缺口绝不补零或沿用上一温度。
 */
export function analyze(dataset: Dataset, settings: Settings, adj: Adjustments): Analysis {
  const maxGapMs = settings.maxGapSeconds * 1000;
  const prepared = prepare(dataset.channels, adj);

  // 全局时间窗：所有通道（含停用，停用只使其自身不可计）首末读数的并集
  let windowStart = Infinity;
  let windowEnd = -Infinity;
  for (const p of prepared) {
    for (const s of p.samples) {
      if (s.t < windowStart) windowStart = s.t;
      if (s.t > windowEnd) windowEnd = s.t;
    }
  }
  if (!isFinite(windowStart)) {
    windowStart = 0;
    windowEnd = 0;
  }

  const holdStart = settings.holdStart;
  const holdEnd = settings.holdEnd;
  const stagesSet = holdStart !== null && holdEnd !== null && holdStart < holdEnd;
  if (stagesSet) {
    windowStart = Math.min(windowStart, holdStart);
    windowEnd = Math.max(windowEnd, holdEnd);
  }

  const built = prepared.map((p) => {
    const b = buildSegments(p.samples, maxGapMs);
    return { raw: p.raw, p, b };
  });

  const probes = built.filter((x) => x.raw.kind === 'probe');

  // 全局时间倒退证据在各通道分析中挂载（最终合并进总 findings）
  const probeSegs = probes.map((x) => x.b.segments);
  const cadence = median(probes.map((x) => x.b.medianStepMs).filter((v): v is number => v !== null));
  const stepForDrift = cadence ?? 15_000;

  const channelResults: ChannelResult[] = built.map(({ p, b }) => {
    const findings: Finding[] = [];
    const blockedReasons = new Set<Finding['code']>();
    const block = (f: Finding) => {
      findings.push(f);
      blockedReasons.add(f.code);
    };
    const warn = (f: Finding) => findings.push(f);

    // 时间倒退：破坏该通道时间轴，block
    for (const r of b.regressions) {
      block({
        code: 'time-regression',
        severity: 'block',
        channelId: p.raw.id,
        from: r.at,
        value: r.deltaMs / 1000,
        message: `${p.raw.name} 在 ${fmtClock(r.at)} 出现时间倒退 ${(r.deltaMs / 1000).toFixed(1)} s：时间轴不单调，该通道结论被阻止，请先校时`,
      });
    }

    // 长缺口：与阶段窗相交即阻止该阶段；任一长缺口落入保温窗则探针整体不可放行
    const longGapInHold =
      stagesSet && b.longGaps.some((g) => g.to > holdStart! && g.from < holdEnd!);
    for (const g of b.longGaps) {
      const durS = (g.to - g.from) / 1000;
      block({
        code: 'long-gap',
        severity: 'block',
        channelId: p.raw.id,
        from: g.from,
        to: g.to,
        value: durS,
        message: `${p.raw.name} 在 ${fmtClock(g.from)}–${fmtClock(g.to)} 缺测 ${durS.toFixed(0)} s（超过允许 ${settings.maxGapSeconds} s），该区间不积分（不补零、不沿用）`,
      });
    }

    // 短缺口：允许插值但留证
    for (const seg of b.segments) {
      if (seg.interpolatedGap) {
        warn({
          code: 'short-gap',
          severity: 'warn',
          channelId: p.raw.id,
          from: seg.t1,
          to: seg.t2,
          value: (seg.t2 - seg.t1) / 1000,
          message: `${p.raw.name} 在 ${fmtClock(seg.t1)}–${fmtClock(seg.t2)} 有 ${((seg.t2 - seg.t1) / 1000).toFixed(0)} s 缺测，已按两端读数线性插值`,
        });
      }
    }

    // 阶段覆盖：每个阶段必须在起点附近和终点附近都有有效覆盖
    const phases: Partial<Record<PhaseKey, PhaseF>> = {};
    const phaseWindows: { key: PhaseKey; start: number; end: number }[] = [];
    if (stagesSet) {
      phaseWindows.push(
        { key: 'comeUp', start: windowStart, end: holdStart! },
        { key: 'hold', start: holdStart!, end: holdEnd! },
        { key: 'cool', start: holdEnd!, end: windowEnd },
      );
    }
    for (const pw of phaseWindows) {
      const reasons: FindingCode[] = [];
      const tol = Math.max(maxGapMs, (pw.end - pw.start) * 0.05);
      const coverStart = b.firstT !== null && b.firstT <= pw.start + tol;
      const coverEnd = b.lastT !== null && b.lastT >= pw.end - tol;
      const gapInside = windowHasLongGap(b.longGaps, pw.start, pw.end);
      const regression = b.regressions.length > 0;
      if (!coverStart || !coverEnd) reasons.push('coverage');
      if (gapInside) reasons.push('long-gap');
      if (regression) reasons.push('time-regression');
      const fVal = integrateWindow(
        b.segments,
        pw.start,
        pw.end,
        settings.refTemp,
        settings.zValue,
      );
      const blocked = reasons.length > 0;
      phases[pw.key] = { key: pw.key, start: pw.start, end: pw.end, f: fVal, blocked, reasons };
      if (!coverStart || !coverEnd) {
        block({
          code: 'coverage',
          severity: 'block',
          channelId: p.raw.id,
          phase: pw.key,
          from: pw.start,
          to: pw.end,
          message: `${p.raw.name} 对${PHASE_LABEL[pw.key]}阶段覆盖不完整（${
            !coverStart ? '起点' : ''
          }${!coverStart && !coverEnd ? '/' : ''}${!coverEnd ? '终点' : ''}无有效读数），${PHASE_LABEL[pw.key]}贡献不可放行`,
        });
      }
    }

    // 漂移：仅对探针、阶段齐全时评估保温中段
    let drift: number | null = null;
    if (p.raw.kind === 'probe' && stagesSet) {
      const others = probeSegs.filter((_, i) => probes[i].raw.id !== p.raw.id);
      const dr = driftResidual(b.segments, others, holdStart!, holdEnd!, stepForDrift);
      if (dr) {
        drift = dr.residual;
        if (Math.abs(dr.residual) >= settings.driftC) {
          block({
            code: 'drift',
            severity: 'block',
            channelId: p.raw.id,
            phase: 'hold',
            value: dr.residual,
            message: `${p.raw.name} 保温中段相对探针中位温度持续偏 ${
              dr.residual < 0 ? '冷' : '热'
            } ${Math.abs(dr.residual).toFixed(2)} °C（阈值 ${settings.driftC} °C），疑似漂移，该探针结论被阻止`,
          });
        } else if (Math.abs(dr.residual) >= settings.driftC * 0.6) {
          warn({
            code: 'drift',
            severity: 'warn',
            channelId: p.raw.id,
            phase: 'hold',
            value: dr.residual,
            message: `${p.raw.name} 保温中段相对中位偏差 ${dr.residual.toFixed(2)} °C，接近漂移阈值，建议人工复核`,
          });
        }
      }
    }

    // 校时建议：探针相对其余探针的中位曲线
    let suggestedOffset: number | null = null;
    if (p.raw.kind === 'probe' && stagesSet && b.medianStepMs !== null && b.regressions.length === 0) {
      const peers = probeSegs.filter((_, i) => probes[i].raw.id !== p.raw.id);
      const lag = suggestClockLag(b.segments, peers, windowStart, holdStart!, b.medianStepMs);
      if (lag) {
        suggestedOffset = p.offset + lag.lagMs;
        if (Math.abs(lag.lagMs) >= Math.max(2 * b.medianStepMs, 5_000)) {
          warn({
            code: 'clock-jump',
            severity: 'warn',
            channelId: p.raw.id,
            value: lag.lagMs / 1000,
            message: `${p.raw.name} 升温曲线相对其余探针整体${lag.lagMs > 0 ? '滞后' : '超前'} ${Math.abs(lag.lagMs / 1000).toFixed(0)} s，疑似时钟错位；已生成校时候选，请比较后采用`,
          });
        }
      }
    }

    if (p.disabled) {
      warn({
        code: 'disabled',
        severity: 'warn',
        channelId: p.raw.id,
        message: `${p.raw.name} 已被停用，不参与冷点与放行判定`,
      });
    }

    const totalF = integrateWindow(
      b.segments,
      windowStart,
      windowEnd,
      settings.refTemp,
      settings.zValue,
    );

    const stageBlocked =
      !stagesSet ||
      (['comeUp', 'hold', 'cool'] as PhaseKey[]).some((k) => phases[k]?.blocked);
    const eligible =
      !p.disabled &&
      blockedReasons.size === 0 &&
      stagesSet &&
      !longGapInHold &&
      stageBlocked === false;

    return {
      id: p.raw.id,
      name: p.raw.name,
      kind: p.raw.kind,
      findings,
      segments: b.segments,
      longGaps: b.longGaps,
      phases,
      totalF,
      driftResidual: drift,
      suggestedOffset,
      offsetApplied: p.offset,
      disabled: p.disabled,
      eligible,
      firstT: b.firstT,
      lastT: b.lastT,
    };
  });

  const globalFindings: Finding[] = [];
  if (!stagesSet) {
    globalFindings.push({
      code: 'no-stages',
      severity: 'block',
      message: '尚未设定保温开始/结束时间，无法拆分升温/保温/降温贡献，放行结论被阻止',
    });
  }

  // 冷点：有效探针中累计 F0 最低者
  const eligibleProbes = channelResults.filter((c) => c.kind === 'probe' && c.eligible);
  const coldPointId =
    eligibleProbes.length > 0
      ? eligibleProbes.reduce((m, c) => (c.totalF < m.totalF ? c : m)).id
      : null;

  // 放行判定（停用探针经人工排除，不计入分母，但在理由中显著列出）
  const verdictReasons: string[] = [];
  let verdict: Analysis['verdict'];
  const consideredProbes = channelResults.filter((c) => c.kind === 'probe' && !c.disabled);
  const disabledProbes = channelResults.filter((c) => c.kind === 'probe' && c.disabled);
  if (!stagesSet) {
    verdict = 'indeterminate';
  } else if (consideredProbes.length === 0) {
    verdict = 'indeterminate';
    verdictReasons.push('没有参与判定的有效探针，无法判定冷点');
  } else if (eligibleProbes.length < consideredProbes.length) {
    verdict = 'indeterminate';
    verdictReasons.push(
      `${consideredProbes.length - eligibleProbes.length} 支探针未通过门禁；冷点仅基于 ${eligibleProbes.length} 支有效探针，需先处理偏差证据`,
    );
  } else {
    const cold = eligibleProbes.find((c) => c.id === coldPointId)!;
    const holdF = cold.phases.hold?.f ?? 0;
    // 放行以冷点全过程累计 F0 达标为准；保温 F0 作为工艺符合性旁证
    if (cold.totalF >= settings.targetF0) {
      verdict = 'pass';
      verdictReasons.push(
        `冷点 ${cold.name} 累计 F0=${cold.totalF.toFixed(2)} min ≥ 目标 ${settings.targetF0} min（其中保温 ${holdF.toFixed(2)} min）`,
      );
    } else {
      verdict = 'fail';
      verdictReasons.push(
        `冷点 ${cold.name} 累计 F0=${cold.totalF.toFixed(2)} min < 目标 ${settings.targetF0} min（保温 ${holdF.toFixed(2)} min）`,
      );
    }
  }
  if (disabledProbes.length > 0) {
    verdictReasons.push(
      `已停用 ${disabledProbes.length} 支探针（${disabledProbes.map((c) => c.name).join('、')}），不参与冷点判定；该排除可撤销`,
    );
  }

  const findings = [...globalFindings, ...channelResults.flatMap((c) => c.findings)];

  return {
    windowStart,
    windowEnd,
    holdStart,
    holdEnd,
    channels: channelResults,
    findings,
    coldPointId,
    verdict,
    verdictReasons,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 相对毫秒时间格式化为 mm:ss（示例数据用相对时间） */
export function fmtClock(t: number): string {
  const totalSec = Math.round(t / 1000);
  const sign = totalSec < 0 ? '-' : '';
  const abs = Math.abs(totalSec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${sign}${h > 0 ? `${h}:${mm}` : mm}:${ss}`;
}
