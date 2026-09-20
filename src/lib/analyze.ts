/**
 * 批分析引擎（纯函数）：
 * 门禁（时间倒退 / 重复时间戳 / 长缺口 / 窗口覆盖）、分阶段 F、
 * 保温段同伴比对（漂移 / 卡死）、冷点判定、放行结论、校时与停用候选。
 *
 * 铁律：任何未知温度区间都不补零、不沿用上一温度；
 * 阻断性缺口所在阶段标记不完整，受影响探针的总 F0 不出数。
 */
import { segmentF, interpAt, type Point } from "./lethality";
import type {
  BatchResult,
  ChannelDef,
  Dataset,
  Defect,
  GapInfo,
  ProbeAnalysis,
  ProcessParams,
  StageDef,
  AdjustmentMap,
} from "../types";

const EPS = 1e-6;

export function stagesOrdered(stages: StageDef[]): StageDef[] {
  return [...stages].sort((a, b) => a.start - b.start);
}

/** 阶段定义必须：时长为正、互不重叠、首尾相接（允许 1s 数值容差） */
export function stageDefects(stages: StageDef[]): string[] {
  const reasons: string[] = [];
  const s = stagesOrdered(stages);
  if (s.length < 3) reasons.push("工艺阶段不完整：需覆盖升温、保温、降温三段");
  for (const st of s) {
    if (!(st.end > st.start)) reasons.push(`阶段「${st.name}」时长非正`);
  }
  for (let i = 1; i < s.length; i++) {
    if (s[i].start < s[i - 1].end - EPS) reasons.push(`阶段「${s[i - 1].name}」与「${s[i].name}」重叠`);
    if (s[i].start > s[i - 1].end + EPS) reasons.push(`阶段「${s[i - 1].name}」与「${s[i].name}」之间存在未定义区间`);
  }
  const kinds = new Set(s.map((x) => x.kind));
  for (const k of ["comeup", "holding", "cooling"] as const) {
    if (!kinds.has(k)) reasons.push(`缺少${{ comeup: "升温", holding: "保温", cooling: "降温" }[k]}阶段`);
  }
  return reasons;
}

interface Integration {
  f: number;
  complete: boolean;
  blockingGaps: { start: number; end: number }[];
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 在 [a,b] 上沿真实采样折线积分。区间跨越超过 maxGapSec 的缺口时，
 * 该段不计入 F，并令 complete=false（绝不补零、不沿用）。
 */
function integrate(points: Point[], a: number, b: number, p: ProcessParams): Integration {
  const out: Integration = { f: 0, complete: true, blockingGaps: [] };
  if (!(b > a)) return out;
  if (points.length < 2 || a < points[0].t - EPS || b > points[points.length - 1].t + EPS) {
    out.complete = false;
    return out;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i].t;
    const t1 = points[i + 1].t;
    const u = Math.max(t0, a);
    const v = Math.min(t1, b);
    if (v <= u) continue;
    const delta = t1 - t0;
    if (delta > p.maxGapSec + EPS) {
      out.complete = false;
      out.blockingGaps.push({ start: t0, end: t1 });
      continue;
    }
    const r0 = (u - t0) / delta;
    const r1 = (v - t0) / delta;
    const Tu = points[i].temp + r0 * (points[i + 1].temp - points[i].temp);
    const Tv = points[i].temp + r1 * (points[i + 1].temp - points[i].temp);
    out.f += segmentF(u, v, Tu, Tv, p.refTemp, p.zValue);
  }
  return out;
}

function overlappedStages(gapStart: number, gapEnd: number, stages: StageDef[]): string[] {
  return stages.filter((s) => gapEnd > s.start + EPS && gapStart < s.end - EPS).map((s) => s.id);
}

export function analyzeChannel(ch: ChannelDef, stages: StageDef[], windowV: [number, number], p: ProcessParams): ProbeAnalysis {
  const defects: Defect[] = [];
  const gaps: GapInfo[] = [];
  const stageF: ProbeAnalysis["stageF"] = {};
  const base: ProbeAnalysis = {
    id: ch.id,
    name: ch.name,
    role: ch.role,
    disabled: false,
    defects,
    valid: false,
    gaps,
    firstT: null,
    lastT: null,
    coversWindow: false,
    stageF,
    totalF: null,
    cum: [],
    holdingMean: null,
    span: null,
  };

  const pts: Point[] = ch.samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.temp));
  if (pts.length < 2) {
    defects.push({ code: "retort-fault", severity: "block", message: `${ch.name}：有效采样不足，无法成线` });
    return base;
  }
  let orderOk = true;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t < pts[i - 1].t) {
      defects.push({
        code: "time-reversal",
        severity: "block",
        message: `${ch.name}：第 ${i + 1} 条采样时间倒退（${fmtT(pts[i].t)} 早于 ${fmtT(pts[i - 1].t)}），时钟数据不可信`,
        start: pts[i].t,
      });
      orderOk = false;
      break;
    }
    if (pts[i].t === pts[i - 1].t) {
      defects.push({
        code: "dueling-timestamp",
        severity: "block",
        message: `${ch.name}：${fmtT(pts[i].t)} 存在两个不同温度的同一时间戳`,
        start: pts[i].t,
      });
      orderOk = false;
      break;
    }
  }
  base.firstT = pts[0].t;
  base.lastT = pts[pts.length - 1].t;
  base.span = Math.max(...pts.map((x) => x.temp)) - Math.min(...pts.map((x) => x.temp));
  if (!orderOk) return base;

  const [w0, w1] = windowV;
  base.coversWindow = pts[0].t <= w0 + EPS && pts[pts.length - 1].t >= w1 - EPS;
  if (!base.coversWindow) {
    defects.push({
      code: "out-of-window",
      severity: "block",
      message: `${ch.name}：未覆盖完整过程窗口（首采 ${fmtT(pts[0].t)}，末采 ${fmtT(pts[pts.length - 1].t)}；窗口 ${fmtT(w0)}–${fmtT(w1)}）`,
    });
  }

  const deltas = pts.slice(1).map((x, i) => x.t - pts[i].t);
  const nominal = median(deltas);
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (d > p.maxGapSec + EPS) {
      const ids = overlappedStages(pts[i].t, pts[i + 1].t, stages);
      gaps.push({ start: pts[i].t, end: pts[i + 1].t, seconds: d, blocking: true, stageIds: ids });
      defects.push({
        code: "long-gap",
        severity: "block",
        message: `${ch.name}：${fmtT(pts[i].t)}–${fmtT(pts[i + 1].t)} 掉线 ${Math.round(d)}s，超过允许缺测 ${p.maxGapSec}s`,
        start: pts[i].t,
        end: pts[i + 1].t,
      });
    } else if (nominal > 0 && d > Math.max(p.maxGapSec * 0.5, nominal * 2.5)) {
      const ids = overlappedStages(pts[i].t, pts[i + 1].t, stages);
      gaps.push({ start: pts[i].t, end: pts[i + 1].t, seconds: d, blocking: false, stageIds: ids });
      defects.push({
        code: "short-gap",
        severity: "warn",
        message: `${ch.name}：${fmtT(pts[i].t)}–${fmtT(pts[i + 1].t)} 缺测 ${Math.round(d)}s（允许内，已插值）`,
        start: pts[i].t,
        end: pts[i + 1].t,
      });
    }
  }

  for (const st of stages) {
    const r = integrate(pts, st.start, st.end, p);
    stageF[st.id] = { f: r.f, complete: r.complete };
  }
  const total = integrate(pts, w0, w1, p);
  base.totalF = total.complete ? total.f : null;
  // 保温段时间加权平均温（仅在覆盖完整时出数）
  const holding = stages.find((s) => s.kind === "holding");
  if (holding) {
    const hr = integrateWeightedTemp(pts, holding.start, holding.end, p.maxGapSec);
    if (hr.complete) base.holdingMean = hr.mean;
  }

  // 累计曲线节点（阻断缺口处为 null 断点，不累加未知贡献）
  base.cum = buildCum(pts, w0, w1, p);
  base.valid = defects.every((d) => d.severity !== "block");
  return base;
}

function integrateWeightedTemp(points: Point[], a: number, b: number, maxGap: number): { mean: number; complete: boolean } {
  let acc = 0;
  let dur = 0;
  let complete = true;
  if (points.length < 2 || a < points[0].t - EPS || b > points[points.length - 1].t + EPS) complete = false;
  for (let i = 0; i < points.length - 1; i++) {
    const u = Math.max(points[i].t, a);
    const v = Math.min(points[i + 1].t, b);
    if (v <= u) continue;
    const delta = points[i + 1].t - points[i].t;
    if (delta > maxGap + EPS) {
      complete = false;
      continue;
    }
    const r0 = (u - points[i].t) / delta;
    const r1 = (v - points[i].t) / delta;
    const Tu = points[i].temp + r0 * (points[i + 1].temp - points[i].temp);
    const Tv = points[i].temp + r1 * (points[i + 1].temp - points[i].temp);
    acc += ((Tu + Tv) / 2) * (v - u);
    dur += v - u;
  }
  const expected = Math.min(b, points[points.length - 1]?.t ?? b) - Math.max(a, points[0]?.t ?? a);
  if (dur < expected - EPS) complete = false;
  return dur > 0 ? { mean: acc / dur, complete } : { mean: NaN, complete: false };
}

function buildCum(pts: Point[], w0: number, w1: number, p: ProcessParams): { t: number; f: number | null }[] {
  const lo = Math.max(w0, pts[0].t);
  const hi = Math.min(w1, pts[pts.length - 1].t);
  if (!(hi > lo)) return [];
  const bounds = [lo, ...pts.map((x) => x.t).filter((t) => t > lo + EPS && t < hi - EPS), hi];
  const nodes: { t: number; f: number | null }[] = [];
  let f = 0;
  for (let k = 0; k < bounds.length; k++) {
    nodes.push({ t: bounds[k], f });
    if (k === bounds.length - 1) break;
    const u = bounds[k];
    const v = bounds[k + 1];
    // 找到包裹 [u,v] 的原始区间
    let i = 0;
    while (i < pts.length - 1 && pts[i + 1].t < v - EPS) i++;
    const delta = pts[i + 1].t - pts[i].t;
    if (delta <= p.maxGapSec + EPS) {
      const r0 = (u - pts[i].t) / delta;
      const r1 = (v - pts[i].t) / delta;
      const Tu = pts[i].temp + r0 * (pts[i + 1].temp - pts[i].temp);
      const Tv = pts[i].temp + r1 * (pts[i + 1].temp - pts[i].temp);
      f += segmentF(u, v, Tu, Tv, p.refTemp, p.zValue);
    } else {
      // 阻断缺口：v 处为断点（f=null）；缺口后独立累计，端点不冒充全批总量
      nodes.push({ t: v, f: null });
      f = 0;
      k++;
    }
  }
  return nodes;
}

/**
 * 探针异常检测（物理判据，避免把真实冷点误判成"偏低漂移"）：
 *  - drift-high：保温段同时持续高于釜温和同伴中位 ≥ 阈值（两条都成立才报，防止釜温传感器自身偏差误伤）；
 *  - drift-low：升温段（釜温≥80℃）持续"领先"釜温，物理上罐内温度不可能高于加热介质；
 *  - stuck：保温段几乎不变化且同伴在波动，或降温开始后釜温骤降而该探针无动于衷。
 */
function peerDefects(channels: ChannelDef[], stages: StageDef[], p: ProcessParams): Map<string, Defect[]> {
  const result = new Map<string, Defect[]>();
  const holding = stages.find((s) => s.kind === "holding");
  const comeup = stages.find((s) => s.kind === "comeup");
  if (!holding) return result;
  const retort = channels.find((c) => c.role === "retort");
  const probes = channels.filter((c) => c.role === "probe");
  const healthy = probes.filter((c) => {
    for (let i = 1; i < c.samples.length; i++) if (c.samples[i].t <= c.samples[i - 1].t) return false;
    return c.samples.length >= 2;
  });
  if (healthy.length < 3 || !retort) return result;

  type Obs = { t: number; temp: number; rt: number };
  const obsMap = new Map<string, Obs[]>();
  for (const c of healthy) obsMap.set(c.id, []);

  // 保温段网格
  for (let t = holding.start + 30; t < holding.end; t += 30) {
    const rr = interpAt(retort.samples, t);
    if (!rr || rr.gapSec > p.maxGapSec + EPS) continue;
    const here: { id: string; temp: number }[] = [];
    for (const c of healthy) {
      const r = interpAt(c.samples, t);
      if (r && r.gapSec <= p.maxGapSec + EPS) here.push({ id: c.id, temp: r.temp });
    }
    if (here.length < Math.max(3, Math.ceil(healthy.length * 0.6))) continue;
    for (const h of here) {
      const others = here.filter((x) => x.id !== h.id).map((x) => x.temp);
      obsMap.get(h.id)!.push({ t, temp: h.temp, rt: rr.temp, } as Obs & { peer?: number });
      (obsMap.get(h.id)![obsMap.get(h.id)!.length - 1] as Obs & { peer?: number }).peer = h.temp - median(others);
    }
  }

  for (const c of healthy) {
    const list: Defect[] = [];
    const obs = obsMap.get(c.id)!;
    if (obs.length >= 6) {
      const temps = obs.map((o) => o.temp);
      const range = Math.max(...temps) - Math.min(...temps);
      const peerRanges = healthy
        .filter((x) => x.id !== c.id)
        .map((x) => {
          const v = obsMap.get(x.id)!.map((o) => o.temp);
          return v.length >= 2 ? Math.max(...v) - Math.min(...v) : NaN;
        })
        .filter((x) => Number.isFinite(x));
      const peerRange = peerRanges.reduce((a, b) => a + b, 0) / Math.max(1, peerRanges.length);

      // 保温段卡死：自身不动而同伴在随釜温波动
      if (range < 0.5 && peerRange > 1.0) {
        list.push({
          code: "stuck",
          severity: "block",
          message: `${c.name}：保温段温度几乎不变（摆幅 ${range.toFixed(2)}℃）而同伴摆幅 ${peerRange.toFixed(2)}℃，疑似探针卡死`,
          start: holding.start,
          end: holding.end,
        });
      }

      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const dRt = obs.map((o) => o.temp - o.rt);
      const dPeer = obs.map((o) => (o as Obs & { peer?: number }).peer ?? 0);
      // 罐内中心温度正常应滞后（低于）釜温；读数持续不低于釜温且显著高于同伴才异常
      const highFrac = obs.filter((_, i) => dRt[i] >= 0 && dPeer[i] >= p.driftBias).length / obs.length;
      if (highFrac >= 0.7 && mean(dRt) >= 0 && mean(dPeer) >= p.driftBias) {
        list.push({
          code: "drift-high",
          severity: "block",
          message: `${c.name}：保温段同时系统性高于釜温 ${mean(dRt).toFixed(2)}℃、高于同伴 ${mean(dPeer).toFixed(2)}℃（阈值 ${p.driftBias}℃），疑似正漂移，读数不得用于放行`,
          start: holding.start,
          end: holding.end,
        });
      }
    }

    // 降温沿卡死：釜温已骤降而该探针无动于衷
    const t1 = holding.end - 30;
    const t2 = Math.min(holding.end + 90, stages[stages.length - 1].end - 15);
    if (t2 > t1) {
      const a = interpAt(c.samples, t1);
      const b = interpAt(c.samples, t2);
      const ra = interpAt(retort.samples, t1);
      const rb = interpAt(retort.samples, t2);
      if (a && b && ra && rb && ra.temp - rb.temp >= 15 && Math.abs(b.temp - a.temp) <= 1) {
        if (!list.some((d) => d.code === "stuck")) {
          list.push({
            code: "stuck",
            severity: "block",
            message: `${c.name}：降温开始后 ${Math.round(t2 - t1)}s 内釜温下降 ${(ra.temp - rb.temp).toFixed(1)}℃，该探针仅变化 ${Math.abs(b.temp - a.temp).toFixed(2)}℃，疑似卡死`,
            start: t1,
            end: t2,
          });
        }
      }
    }

    // 升温段不可能领先：罐内温度持续高于釜温
    if (comeup) {
      const leads: number[] = [];
      for (let t = comeup.start; t < comeup.end; t += 30) {
        const rr = interpAt(retort.samples, t);
        const q = interpAt(c.samples, t);
        if (!rr || !q || rr.temp < 80) continue;
        if (rr.gapSec > p.maxGapSec + EPS || q.gapSec > p.maxGapSec + EPS) continue;
        leads.push(q.temp - rr.temp);
      }
      if (leads.length >= 4) {
        const meanLead = leads.reduce((a, b) => a + b, 0) / leads.length;
        const frac = leads.filter((x) => x >= p.driftBias).length / leads.length;
        if (frac >= 0.7 && meanLead >= p.driftBias) {
          list.push({
            code: "drift-low",
            severity: "block",
            message: `${c.name}：升温段罐内温度持续高于釜温 ${meanLead.toFixed(2)}℃，物理上不可能，疑似时钟或传感器异常`,
            start: comeup.start,
            end: comeup.end,
          });
        }
      }
    }

    if (list.length) result.set(c.id, list);
  }
  return result;
}

/** 按调整方案生成新数据集：停用通道剔除，校时通道整体平移时间戳 */
export function applyAdjustments(dataset: Dataset, adjustments: AdjustmentMap): Dataset {
  return {
    ...dataset,
    channels: dataset.channels
      .filter((c) => !adjustments[c.id]?.disabled)
      .map((c) => {
        const adj = adjustments[c.id];
        if (!adj || !adj.offsetSeconds) return c;
        return { ...c, samples: c.samples.map((s) => ({ t: s.t + adj.offsetSeconds!, temp: s.temp })) };
      }),
  };
}

export function analyzeBatch(dataset: Dataset, params: ProcessParams): BatchResult {
  const ordered = stagesOrdered(dataset.stages);
  const stageReasons = stageDefects(dataset.stages);
  const windowV: [number, number] = ordered.length
    ? [ordered[0].start, ordered[ordered.length - 1].end]
    : [0, 0];

  const peerMap = stageReasons.length === 0 ? peerDefects(dataset.channels, ordered, params) : new Map<string, Defect[]>();

  const retortCh = dataset.channels.find((c) => c.role === "retort") ?? null;
  const probeChs = dataset.channels.filter((c) => c.role === "probe");
  const retort = retortCh ? withPeer(analyzeChannel(retortCh, ordered, windowV, params), null) : null;
  const probes = probeChs.map((c) => withPeer(analyzeChannel(c, ordered, windowV, params), peerMap.get(c.id) ?? null));

  const reasons: string[] = [...stageReasons];
  if (!retortCh) reasons.push("缺少釜温通道");
  else if (!retort?.valid) reasons.push("釜温通道存在阻断性缺陷，无法确认工艺实际执行，整批不出结论");

  const invalidNames = probes.filter((x) => !x.valid).map((x) => x.name);
  if (probes.length === 0) reasons.push("没有可用探针");
  else if (invalidNames.length) reasons.push(`探针数据缺陷阻止其结论：${invalidNames.join("、")}（该等罐位未经有效验证）`);

  const valid = probes.filter((x) => x.valid && x.totalF !== null);
  let coldPoint: BatchResult["coldPoint"] = null;
  if (valid.length) {
    const cp = valid.reduce((a, b) => (a.totalF! <= b.totalF! ? a : b));
    coldPoint = { id: cp.id, name: cp.name, f: cp.totalF! };
    if (cp.totalF! < params.targetF0) {
      reasons.push(`冷点 ${cp.name} 累计 F0=${cp.totalF!.toFixed(2)} min，低于目标 ${params.targetF0} min`);
    }
  }

  const hasBlock = !!stageReasons.length || !retort || probes.length === 0 || probes.some((x) => !x.valid);
  const hasWarn = probes.some((x) => x.defects.some((d) => d.severity === "warn"));
  let verdict: BatchResult["verdict"];
  if (hasBlock) verdict = "block";
  else if (coldPoint && coldPoint.f < params.targetF0) verdict = "hold";
  else if (hasWarn) verdict = "conditional";
  else verdict = "pass";

  return { window: windowV, retort, probes, coldPoint, verdict, reasons };
}

function withPeer(a: ProbeAnalysis, peer: Defect[] | null): ProbeAnalysis {
  if (peer) {
    a.defects.push(...peer);
    a.valid = a.defects.every((d) => d.severity !== "block");
    // valid=false 时 totalF 仍可展示，但不得作为放行依据（见 analyzeBatch 的冷点筛选）
  }
  return a;
}

export interface AdjustCandidate {
  channelId: string;
  channelName: string;
  kind: "timeshift" | "disable";
  offsetSeconds?: number;
  rationale: string;
}

/**
 * 候选（仅供比较，不直接生效）：
 * - 校时：搜索 ±180s 平移，使该通道在升温+保温段与同伴中位曲线最贴合；
 * - 停用：存在阻断性缺陷的通道可停用后比较（罐位随之失去验证）。
 */
export function suggestCandidates(dataset: Dataset, params: ProcessParams): AdjustCandidate[] {
  const out: AdjustCandidate[] = [];
  const ordered = stagesOrdered(dataset.stages);
  const holding = ordered.find((s) => s.kind === "holding");
  if (!holding || ordered.length === 0) return out;
  const baseline = analyzeBatch(dataset, params);
  const probes = dataset.channels.filter((c) => c.role === "probe");

  for (const ch of probes) {
    const analysis = baseline.probes.find((x) => x.id === ch.id);
    if (analysis && !analysis.valid) {
      const codes = analysis.defects.filter((d) => d.severity === "block").map((d) => d.message.split("：")[0]);
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        kind: "disable",
        rationale: `停用以排除阻断性缺陷（${[...new Set(codes)].join("、") || "数据缺陷"}）；该罐位将失去本批验证`,
      });
    }

    // 校时判据：跨温时刻偏移在“升温”与“降温”两个方向上一致 → 整体时钟错位；
    // 单纯的罐位热惯性在两个方向上的滞后量不同（升温/冷却时间常数不同），会发散。
    const crossAt = (c: typeof ch, temp: number, dir: 1 | -1): number => {
      const pts = c.samples;
      for (let i = 1; i < pts.length; i++) {
        const x = pts[i - 1];
        const y = pts[i];
        if (dir === 1 && x.temp < temp && y.temp >= temp) {
          const r = (temp - x.temp) / (y.temp - x.temp);
          return x.t + r * (y.t - x.t);
        }
        if (dir === -1 && x.temp > temp && y.temp <= temp) {
          const r = (x.temp - temp) / (x.temp - y.temp);
          return x.t + r * (y.t - x.t);
        }
      }
      return NaN;
    };
    const comeupStage = ordered.find((x) => x.kind === "comeup");
    const coolingStage = ordered.find((x) => x.kind === "cooling");
    const dirOffsets = (levels: number[], dir: 1 | -1, stage: typeof comeupStage): number[] | null => {
      const out2: number[] = [];
      for (const T of levels) {
        const mine = crossAt(ch, T, dir);
        const peersT = probes
          .filter((c) => c.id !== ch.id)
          .map((c) => crossAt(c, T, dir))
          .filter((x) => Number.isFinite(x));
        if (!Number.isFinite(mine) || peersT.length < 2) return null;
        if (stage && !(mine >= stage.start && mine <= stage.end)) return null;
        out2.push(mine - median(peersT));
      }
      return out2;
    };
    const up = comeupStage ? dirOffsets([75, 85, 95], 1, comeupStage) : null;
    const down = coolingStage ? dirOffsets([115, 110, 105], -1, coolingStage) : null;
    if (up && down && up.length === 3 && down.length === 3) {
      const upMed = median(up);
      const downMed = median(down);
      const upSpread = Math.max(...up) - Math.min(...up);
      const downSpread = Math.max(...down) - Math.min(...down);
      const sameSign = Math.sign(upMed) === Math.sign(downMed);
      const rounded = Math.round(((upMed + downMed) / 2 / 15)) * 15;
      if (
        sameSign &&
        Math.abs(upMed) >= 30 &&
        Math.abs(downMed) >= 30 &&
        Math.abs(upMed - downMed) <= 8 &&
        upSpread <= 15 &&
        downSpread <= 20 &&
        Math.abs(rounded) >= 30
      ) {
        out.push({
          channelId: ch.id,
          channelName: ch.name,
          kind: "timeshift",
          offsetSeconds: -rounded,
          rationale: `升温跨 75/85/95℃ 与降温跨 115/110/105℃ 一致滞后同伴约 ${Math.round(upMed)}/${Math.round(downMed)}s（双向一致，热惯性差异不会如此），疑似整体时钟错位；建议时间轴平移 ${-rounded > 0 ? "+" : ""}${-rounded}s 后比较`,
        });
      }
    }
  }
  return out;
}

export function trialAdjustments(current: AdjustmentMap, cand: AdjustCandidate): AdjustmentMap {
  const next: AdjustmentMap = { ...current };
  if (cand.kind === "disable") {
    next[cand.channelId] = { ...(next[cand.channelId] ?? { offsetSeconds: 0, disabled: false }), disabled: true, reason: cand.rationale };
  } else {
    const prev = next[cand.channelId] ?? { offsetSeconds: 0, disabled: false };
    next[cand.channelId] = { ...prev, offsetSeconds: (prev.offsetSeconds ?? 0) + (cand.offsetSeconds ?? 0), reason: cand.rationale };
  }
  return next;
}

function fmtT(t: number): string {
  const neg = t < 0;
  const s = Math.round(Math.abs(t));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${neg ? "-" : ""}${mm}:${ss.toString().padStart(2, "0")}`;
}
