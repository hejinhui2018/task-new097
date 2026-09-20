/**
 * 领域类型定义 —— 热穿透放行复核台
 * 时间单位：秒（相对过程起点的连续实数时间轴）；F0 单位：分钟。
 */

/** 单条有效采样；掉线时刻不产生采样，相邻有效采样之间的时间差即缺测跨度 */
export interface Sample {
  t: number;
  temp: number;
}

export type StageKind = "comeup" | "holding" | "cooling";

export interface StageDef {
  id: string;
  name: string;
  kind: StageKind;
  /** 过程相对时间（秒），左闭右开 [start, end) */
  start: number;
  end: number;
}

export type ChannelRole = "retort" | "probe";

export interface ChannelDef {
  id: string;
  name: string;
  role: ChannelRole;
  samples: Sample[];
}

export interface Dataset {
  id: string;
  name: string;
  importedAt: number;
  channels: ChannelDef[];
  stages: StageDef[];
}

export interface ProcessParams {
  /** 参考温度 T_ref（℃），通常 121.1 */
  refTemp: number;
  /** z 值（℃），通常 10 */
  zValue: number;
  /** 目标 F0（min） */
  targetF0: number;
  /** 允许缺测时长（s）：跨度超过该值的缺口不得插值放行 */
  maxGapSec: number;
  /** 保温段疑似漂移判据：与同伴中位数温差（℃） */
  driftBias: number;
}

export const DEFAULT_PARAMS: ProcessParams = {
  refTemp: 121.1,
  zValue: 10,
  targetF0: 30,
  maxGapSec: 90,
  driftBias: 2.0,
};

export type DefectCode =
  | "time-reversal"
  | "dueling-timestamp"
  | "out-of-window"
  | "long-gap"
  | "short-gap"
  | "drift-high"
  | "drift-low"
  | "stuck"
  | "retort-fault";

export interface Defect {
  code: DefectCode;
  severity: "block" | "warn";
  message: string;
  start?: number;
  end?: number;
}

export interface GapInfo {
  start: number;
  end: number;
  seconds: number;
  blocking: boolean;
  stageIds: string[];
}

export interface StageF {
  f: number;
  complete: boolean;
}

export type Verdict = "pass" | "conditional" | "block" | "hold";

export interface ProbeAnalysis {
  id: string;
  name: string;
  role: ChannelRole;
  disabled: boolean;
  defects: Defect[];
  /** 无 block 级缺陷且窗口覆盖完整 */
  valid: boolean;
  gaps: GapInfo[];
  firstT: number | null;
  lastT: number | null;
  coversWindow: boolean;
  stageF: Record<string, StageF>;
  /** 完整覆盖时的累计 F0（min）；任一区间不可信则为 null */
  totalF: number | null;
  /** 累计 F0 节点（与落在窗口内的采样对齐）；阻断缺口处 f=null，折线必须断开 */
  cum: { t: number; f: number | null }[];
  /** 保温段时间加权平均温（℃），覆盖不完整为 null */
  holdingMean: number | null;
  /** 窗口内温度跨度（℃） */
  span: number | null;
}

export interface BatchResult {
  window: [number, number];
  retort: ProbeAnalysis | null;
  probes: ProbeAnalysis[];
  coldPoint: { id: string; name: string; f: number } | null;
  verdict: Verdict;
  reasons: string[];
}

export interface ProbeAdjust {
  offsetSeconds: number;
  disabled: boolean;
  reason?: string;
}

export type AdjustmentMap = Record<string, ProbeAdjust>;
