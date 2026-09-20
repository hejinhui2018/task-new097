import type { Settings } from '../types';
import type { ChannelResult, Analysis } from '../types';
import { analyze } from './analyze';
import { tempAt } from './segments';
import type { TempSegment } from '../types';

/**
 * 依据釜温自动识别保温段：
 * - 起点 = 首次达到 holdTemp 且其后 sustainMs 内始终 ≥ holdTemp 的时刻；
 * - 终点 = 起点后首次跌破 holdTemp 且其后 sustainMs 内始终 < holdTemp 的时刻。
 * 升温中的短暂过冲、保温中的小幅波动都不会误触发。
 */
export function detectHoldStages(
  retortSegments: TempSegment[],
  holdTemp: number,
  sustainMs = 60_000,
): { holdStart: number | null; holdEnd: number | null } {
  if (retortSegments.length === 0) return { holdStart: null, holdEnd: null };
  const start = retortSegments[0].t1;
  const end = retortSegments[retortSegments.length - 1].t2;
  const scanStep = 5_000;

  const temps: { t: number; v: number | null }[] = [];
  for (let t = start; t <= end; t += scanStep) temps.push({ t, v: tempAt(retortSegments, t) });

  const stays = (fromIdx: number, pred: (v: number | null) => boolean): boolean => {
    for (let i = fromIdx; i < temps.length && temps[i].t - temps[fromIdx].t <= sustainMs; i++) {
      if (!pred(temps[i].v)) return false;
    }
    return true;
  };

  let holdStartIdx = -1;
  for (let i = 0; i < temps.length; i++) {
    const tv = temps[i].v;
    if (tv !== null && tv >= holdTemp && stays(i, (v) => v !== null && v >= holdTemp)) {
      holdStartIdx = i;
      break;
    }
  }
  if (holdStartIdx === -1) return { holdStart: null, holdEnd: null };

  let holdEnd: number | null = null;
  for (let i = holdStartIdx; i < temps.length; i++) {
    const tv = temps[i].v;
    if (tv !== null && tv < holdTemp && stays(i, (v) => v !== null && v < holdTemp)) {
      holdEnd = temps[i].t;
      break;
    }
  }
  return { holdStart: temps[holdStartIdx].t, holdEnd };
}

export interface CandidateSpec {
  kind: 'offset' | 'disable' | 'enable' | 'clearOffset';
  channelId: string;
  /** offset 候选时的目标总偏移 ms */
  offsetMs?: number;
  label: string;
}

export interface CandidateComparison {
  spec: CandidateSpec;
  before: {
    verdict: Analysis['verdict'];
    coldPointId: string | null;
    channel: ChannelResult;
  };
  after: {
    verdict: Analysis['verdict'];
    coldPointId: string | null;
    channel: ChannelResult;
  };
  analysis: Analysis;
}

/** 以候选调整做一次“影子分析”，与当前采用结果并列比较，不改变任何现状 */
export function compareCandidate(
  dataset: import('../types').Dataset,
  settings: Settings,
  currentAdj: import('../types').Adjustments,
  spec: CandidateSpec,
): CandidateComparison {
  const before = analyze(dataset, settings, currentAdj);

  const next = structuredCloneSafe(currentAdj);
  const ch = spec.channelId;
  if (spec.kind === 'offset') next.offsets[ch] = Math.round(spec.offsetMs ?? 0);
  if (spec.kind === 'clearOffset') delete next.offsets[ch];
  if (spec.kind === 'disable') next.disabled[ch] = true;
  if (spec.kind === 'enable') delete next.disabled[ch];

  const analysis = analyze(dataset, settings, next);
  return {
    spec,
    before: {
      verdict: before.verdict,
      coldPointId: before.coldPointId,
      channel: before.channels.find((c) => c.id === ch)!,
    },
    after: {
      verdict: analysis.verdict,
      coldPointId: analysis.coldPointId,
      channel: analysis.channels.find((c) => c.id === ch)!,
    },
    analysis,
  };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
