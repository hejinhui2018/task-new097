// 领域类型定义：时间一律使用毫秒（epoch 或相对毫秒），F0 单位为分钟。

export interface RawSample {
  /** 采样时间（ms） */
  t: number;
  /** 温度 °C；null 表示该采样点缺测（掉线/空记录） */
  temp: number | null;
}

export type ChannelKind = 'retort' | 'probe';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** 导入时的原始采样（保持原序，不做修补） */
  samples: RawSample[];
}

export interface Dataset {
  channels: Channel[];
}

export interface Settings {
  /** 参考温度 °C（典型 121.1） */
  refTemp: number;
  /** z 值 °C（典型 10） */
  zValue: number;
  /** 目标 F0（min） */
  targetF0: number;
  /** 允许缺测时长（s）：跨过缺测的有效读数间隔不超过该值才允许线性插值 */
  maxGapSeconds: number;
  /** 保温判定温度 °C，用于从釜温自动识别阶段边界 */
  holdTemp: number;
  /** 保温开始（ms）；null 表示尚未设定，阶段贡献将被门禁阻止 */
  holdStart: number | null;
  /** 保温结束（ms） */
  holdEnd: number | null;
  /** 漂移判定阈值 °C：保温中段探针相对中位温度的持续偏差 */
  driftC: number;
}

/** 已采用的校正：校时偏移（ms，加到原始时间戳上）与停用标记 */
export interface Adjustments {
  offsets: Record<string, number>;
  disabled: Record<string, boolean>;
}

export type Severity = 'block' | 'warn';

export type FindingCode =
  | 'time-regression'
  | 'long-gap'
  | 'short-gap'
  | 'coverage'
  | 'drift'
  | 'clock-jump'
  | 'disabled'
  | 'no-stages';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  channelId?: string;
  phase?: PhaseKey;
  /** 证据时间区间（ms） */
  from?: number;
  to?: number;
  message: string;
  /** 数值证据（偏差 °C、缺口 s 等） */
  value?: number;
}

export type PhaseKey = 'comeUp' | 'hold' | 'cool';

/** 可积分的温度直线段（真实时间轴上相邻有效读数之间） */
export interface TempSegment {
  t1: number;
  t2: number;
  T1: number;
  T2: number;
  /** 该段跨过缺测（短缺口，线性插值，证据中保留） */
  interpolatedGap: boolean;
}

export interface GapRange {
  from: number;
  to: number;
}

export interface PhaseF {
  key: PhaseKey;
  start: number;
  end: number;
  /** 该阶段可积片段合计 F0；阶段被门禁阻止时仅代表已测片段，不可放行 */
  f: number;
  blocked: boolean;
  reasons: FindingCode[];
}

export interface ChannelResult {
  id: string;
  name: string;
  kind: ChannelKind;
  findings: Finding[];
  segments: TempSegment[];
  /** 未积分的长缺口区间（禁止补零/沿用上一温度） */
  longGaps: GapRange[];
  phases: Partial<Record<PhaseKey, PhaseF>>;
  /** 全部可积片段合计 F0（探针无效时仅供证据展示） */
  totalF: number;
  /** 保温中段相对探针中位温度的持续偏差 °C */
  driftResidual: number | null;
  /** 校时建议偏移（ms，加到时间戳）；null=无建议 */
  suggestedOffset: number | null;
  offsetApplied: number;
  disabled: boolean;
  /** 是否可计入放行（无 block 级发现、未停用、阶段覆盖完整） */
  eligible: boolean;
  firstT: number | null;
  lastT: number | null;
}

export type Verdict = 'pass' | 'fail' | 'indeterminate';

export interface Analysis {
  windowStart: number;
  windowEnd: number;
  holdStart: number | null;
  holdEnd: number | null;
  channels: ChannelResult[];
  findings: Finding[];
  coldPointId: string | null;
  verdict: Verdict;
  verdictReasons: string[];
}
