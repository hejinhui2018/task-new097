import { describe, it, expect } from "vitest";
import { segmentF, lethalityRate, interpAt } from "./lethality";
import { analyzeBatch, analyzeChannel, stageDefects, applyAdjustments, suggestCandidates } from "./analyze";
import type { ChannelDef, Dataset, ProcessParams, StageDef } from "../types";
import { buildSampleDataset } from "./sample";
import { initHistory, pushState, undo, redo } from "./history";

const P: ProcessParams = { refTemp: 121.1, zValue: 10, targetF0: 6, maxGapSec: 90, driftBias: 2 };

const STAGES: StageDef[] = [
  { id: "up", name: "升温", kind: "comeup", start: 0, end: 120 },
  { id: "hold", name: "保温", kind: "holding", start: 120, end: 720 },
  { id: "cool", name: "降温", kind: "cooling", start: 720, end: 840 },
];

function ch(id: string, role: "retort" | "probe", pts: [number, number][]): ChannelDef {
  return { id, name: id, role, samples: pts.map(([t, temp]) => ({ t, temp })) };
}

/** 构造一条在 [0,840] 内保温段近似恒温 holdTemp 的通道（秒） */
function constProbe(id: string, holdTemp: number, step = 30): ChannelDef {
  const pts: [number, number][] = [];
  for (let t = 0; t <= 840; t += step) {
    let temp: number;
    if (t < 120) temp = 20 + ((holdTemp - 20) * t) / 120;
    else if (t <= 720) temp = holdTemp;
    else temp = holdTemp - ((holdTemp - 30) * (t - 720)) / 120;
    pts.push([t, Math.round(temp * 100) / 100]);
  }
  return ch(id, "probe", pts);
}

function constRetort(step = 30): ChannelDef {
  const pts: [number, number][] = [];
  for (let t = 0; t <= 840; t += step) {
    let temp: number;
    if (t < 120) temp = 40 + ((121.4 - 40) * t) / 120;
    else if (t <= 720) temp = 121.4;
    else temp = 121.4 - ((121.4 - 40) * (t - 720)) / 120;
    pts.push([t, Math.round(temp * 100) / 100]);
  }
  return ch("retort", "retort", pts);
}

function dataset(probes: ChannelDef[], stages = STAGES): Dataset {
  return { id: "d", name: "d", importedAt: 0, channels: [constRetort(), ...probes], stages };
}

describe("致死率与不规则积分", () => {
  it("参考温处瞬时致死率为 1 min⁻¹", () => {
    expect(lethalityRate(121.1, 121.1, 10)).toBeCloseTo(1, 10);
    expect(lethalityRate(131.1, 121.1, 10)).toBeCloseTo(10, 10);
    expect(lethalityRate(111.1, 121.1, 10)).toBeCloseTo(0.1, 10);
  });

  it("恒温 600s = 10 min，F 等于 10·L", () => {
    expect(segmentF(0, 600, 121.1, 121.1, 121.1, 10)).toBeCloseTo(10, 10);
  });

  it("线性升温区间的对数平均精确积分与高分辨率参考一致", () => {
    // 粗区间：300s 从 110 升到 125
    const coarse = segmentF(0, 300, 110, 125, 121.1, 10);
    // 参考：切成 30000 个微小区间数值积分
    let ref = 0;
    const n = 30000;
    for (let i = 0; i < n; i++) {
      const t1 = (300 * i) / n;
      const t2 = (300 * (i + 1)) / n;
      const T1 = 110 + (15 * i) / n;
      const T2 = 110 + (15 * (i + 1)) / n;
      ref += segmentF(t1, t2, T1, T2, 121.1, 10);
    }
    expect(coarse).toBeCloseTo(ref, 8);
    // 且明显高于梯形近似（指数函数下梯形会高估）
    const trap = (300 / 60) * (lethalityRate(110, 121.1, 10) + lethalityRate(125, 121.1, 10)) / 2;
    expect(Math.abs(coarse - ref)).toBeLessThan(Math.abs(trap - ref) / 100);
  });

  it("不规则采样：同一温度历程，疏密采样得到相同 F", () => {
    const mk = (steps: number[]) => {
      const pts = steps.map((t): [number, number] => {
        const temp = t < 120 ? 20 + ((120 - 20) * t) / 120 : t <= 720 ? 120 : 120 - ((120 - 30) * (t - 720)) / 120;
        return [t, temp];
      });
      return analyzeChannel(ch("x", "probe", pts), STAGES, [0, 840], P);
    };
    const dense = mk(Array.from({ length: 29 }, (_, i) => i * 30));
    const irregular = mk([0, 15, 47, 90, 120, 200, 280, 333, 400, 470, 540, 600, 640, 720, 760, 810, 840]);
    expect(dense.totalF).not.toBeNull();
    expect(irregular.totalF).not.toBeNull();
    expect(irregular.totalF!).toBeCloseTo(dense.totalF!, 6);
  });

  it("interpAt 不做外推、不补零", () => {
    const pts = [
      { t: 0, temp: 10 },
      { t: 10, temp: 20 },
    ];
    expect(interpAt(pts, 5)?.temp).toBe(15);
    expect(interpAt(pts, -1)).toBeNull();
    expect(interpAt(pts, 11)).toBeNull();
  });
});

describe("阶段边界与分阶段贡献", () => {
  it("三段贡献之和等于总 F0，且保温段占绝大头", () => {
    const r = analyzeBatch(dataset([constProbe("a", 120)]), P);
    const a = r.probes[0];
    const sum = STAGES.reduce((s, st) => s + a.stageF[st.id].f, 0);
    expect(a.totalF).toBeCloseTo(sum, 8);
    expect(a.stageF["up"].f).toBeGreaterThan(0);
    expect(a.stageF["cool"].f).toBeGreaterThan(0);
    expect(a.stageF["hold"].f).toBeGreaterThan(a.stageF["up"].f + a.stageF["cool"].f);
    // 600s @120℃: L=10^-0.11=0.776, F≈4.66
    expect(a.stageF["hold"].f).toBeCloseTo(10 * lethalityRate(120, 121.1, 10), 1);
  });

  it("阶段定义非法（重叠/缺口/无保温）被报告", () => {
    expect(stageDefects(STAGES)).toEqual([]);
    expect(stageDefects([...STAGES.slice(0, 2)])).toContain("工艺阶段不完整：需覆盖升温、保温、降温三段");
    const overlap = [
      { id: "a", name: "A", kind: "comeup" as const, start: 0, end: 130 },
      { id: "b", name: "B", kind: "holding" as const, start: 120, end: 720 },
      { id: "c", name: "C", kind: "cooling" as const, start: 720, end: 840 },
    ];
    expect(stageDefects(overlap).join("")).toContain("重叠");
    const noHold = [
      { id: "a", name: "A", kind: "comeup" as const, start: 0, end: 120 },
      { id: "c", name: "C", kind: "cooling" as const, start: 120, end: 840 },
    ];
    expect(stageDefects(noHold).join("")).toContain("缺少保温");
  });

  it("采样恰止于阶段边界时覆盖完整；差 1s 不完整", () => {
    const exact = analyzeChannel(constProbe("a", 120), STAGES, [0, 840], P);
    expect(exact.coversWindow).toBe(true);
    const pts = constProbe("a", 120).samples.filter((s) => s.t <= 839);
    const short1 = analyzeChannel(ch("a", "probe", pts.map((s) => [s.t, s.temp] as [number, number])), STAGES, [0, 840], P);
    expect(short1.coversWindow).toBe(false);
    expect(short1.valid).toBe(false);
  });
});

describe("缺口与时间轴门禁", () => {
  it("超过允许缺测的长缺口阻断该探针，但不牵连其他探针", () => {
    const good = constProbe("good", 119.5);
    const pts = constProbe("bad", 119.5).samples.filter((s) => !(s.t > 300 && s.t < 450)); // 180s 缺口
    const r = analyzeBatch(dataset([good, ch("bad", "probe", pts.map((s) => [s.t, s.temp] as [number, number]))]), P);
    const bad = r.probes.find((x) => x.id === "bad")!;
    const ok = r.probes.find((x) => x.id === "good")!;
    expect(bad.valid).toBe(false);
    expect(bad.defects.some((d) => d.code === "long-gap")).toBe(true);
    expect(bad.totalF).toBeNull();
    expect(ok.valid).toBe(true);
    expect(r.verdict).toBe("block");
    expect(r.reasons.join("")).toContain("bad");
  });

  it("允许内的短缺测给警告并插值放行（条件通过）", () => {
    const pts = constProbe("a", 119.5).samples.filter((s) => !(s.t > 300 && s.t < 390)); // 300→390 = 90s 上限
    const r = analyzeBatch(dataset([ch("a", "probe", pts.map((s) => [s.t, s.temp] as [number, number]))]), {
      ...P,
      targetF0: 0.1,
    });
    const a = r.probes[0];
    expect(a.valid).toBe(true);
    expect(a.gaps.some((g) => g.blocking === false)).toBe(true);
    expect(a.totalF).not.toBeNull();
    expect(r.verdict).not.toBe("block");
  });

  it("时间倒退直接阻断，不排序掩盖", () => {
    const pts: [number, number][] = [
      [0, 20],
      [60, 100],
      [50, 95],
      [120, 118],
    ];
    const a = analyzeChannel(ch("a", "probe", pts), STAGES, [0, 840], P);
    expect(a.defects.some((d) => d.code === "time-reversal")).toBe(true);
    expect(a.valid).toBe(false);
  });

  it("长缺口落在保温段时该阶段标记不完整", () => {
    const pts = constProbe("a", 120).samples.filter((s) => !(s.t > 400 && s.t < 600));
    const a = analyzeChannel(ch("a", "probe", pts.map((s) => [s.t, s.temp] as [number, number])), STAGES, [0, 840], P);
    expect(a.stageF["hold"].complete).toBe(false);
    expect(a.totalF).toBeNull();
  });
});

describe("冷点判定", () => {
  it("累计 F0 最低的有效探针成为冷点；无效探针不参与", () => {
    const r = analyzeBatch(dataset([constProbe("hot", 121), constProbe("cold", 118.5), constProbe("mid", 120)]), {
      ...P,
      targetF0: 1,
    });
    expect(r.probes.every((x) => x.valid)).toBe(true);
    expect(r.coldPoint?.id).toBe("cold");
    expect(r.verdict).toBe("pass");
  });

  it("全部探针有效但冷点不达标 → hold（不放行）", () => {
    const r = analyzeBatch(dataset([constProbe("a", 115), constProbe("b", 116)]), P);
    expect(r.coldPoint?.id).toBe("a");
    expect(r.verdict).toBe("hold");
  });
});

describe("漂移与卡死", () => {
  it("保温段系统性偏高 2.5℃ 的探针被判漂移并阻断", () => {
    const shifted: [number, number][] = constProbe("drift", 119).samples.map((s) => [
      s.t,
      s.t >= 120 && s.t <= 720 ? s.temp + 2.5 : s.temp,
    ]);
    const r = analyzeBatch(
      dataset([constProbe("a", 119), constProbe("b", 119.2), constProbe("c", 118.8), ch("drift", "probe", shifted)]),
      P,
    );
    const d = r.probes.find((x) => x.id === "drift")!;
    expect(d.defects.some((x) => x.code === "drift-high")).toBe(true);
    expect(d.valid).toBe(false);
    expect(r.coldPoint?.id).not.toBe("drift");
  });

  it("保温段卡死（自身恒定而同伴随釜温波动）被识别", () => {
    // 同伴在保温段带 ±0.9℃ 波动；卡死探针恒定 118.0
    const ripple = (id: string, base: number): ChannelDef =>
      ch(
        id,
        "probe",
        constProbe(id, base).samples.map((s) =>
          s.t >= 120 && s.t <= 720 ? [s.t, base + 0.9 * Math.sin(s.t / 55)] : [s.t, s.temp],
        ),
      );
    const stuckPts: [number, number][] = constProbe("stuck", 118).samples.map((s) => [
      s.t,
      s.t >= 120 && s.t <= 720 ? 118.0 : s.temp,
    ]);
    const r = analyzeBatch(
      dataset([ripple("a", 119), ripple("b", 120.2), ripple("c", 118.6), ch("stuck", "probe", stuckPts)]),
      P,
    );
    expect(r.probes.find((x) => x.id === "stuck")!.defects.some((d) => d.code === "stuck")).toBe(true);
    expect(r.probes.find((x) => x.id === "stuck")!.valid).toBe(false);
  });
});

describe("候选与历史恢复", () => {
  it("内置示例：P3 产生校时候选，P6 产生停用候选，P5 有允许内缺口", () => {
    const ds = buildSampleDataset();
    const cands = suggestCandidates(ds, { ...P, driftBias: 2, maxGapSec: 90 });
    const shift = cands.find((c) => c.channelId === "p3" && c.kind === "timeshift");
    expect(shift).toBeTruthy();
    expect(Math.abs(shift!.offsetSeconds!)).toBeGreaterThanOrEqual(30);
    const r = analyzeBatch(ds, { ...P, driftBias: 2, targetF0: 1, maxGapSec: 90 });
    const p6 = r.probes.find((x) => x.id === "p6")!;
    expect(p6.valid).toBe(false);
    expect(cands.some((c) => c.channelId === "p6" && c.kind === "disable")).toBe(true);
    const p5 = r.probes.find((x) => x.id === "p5")!;
    expect(p5.gaps.some((g) => g.blocking === false)).toBe(true);
  });

  it("校时候选采用后缺陷消除、冷点可重新比较；撤销精确还原", () => {
    const ds = buildSampleDataset();
    const params = { ...P, driftBias: 2, targetF0: 1, maxGapSec: 90 };
    const cands = suggestCandidates(ds, params);
    const shift = cands.find((c) => c.channelId === "p3" && c.kind === "timeshift")!;

    let hist = initHistory<{ ds: Dataset; adj: Record<string, { offsetSeconds: number; disabled: boolean }> }>({
      ds,
      adj: {},
    });
    const beforeP3 = analyzeBatch(ds, params).probes.find((x) => x.id === "p3")!;

    // 采用校时
    const adj = { p3: { offsetSeconds: shift.offsetSeconds!, disabled: false } };
    const fixed = applyAdjustments(ds, adj);
    hist = pushState(hist, { ds: fixed, adj }, "校时 P3");
    const afterP3 = analyzeBatch(fixed, params).probes.find((x) => x.id === "p3")!;
    // 校时后 P3 与同伴的保温偏差应明显下降（不产生漂移误报）
    expect(afterP3.defects.some((d) => d.code.startsWith("drift"))).toBe(false);
    expect(hist.past).toHaveLength(1);

    // 撤销 → 精确回到原数据
    hist = undo(hist);
    expect(hist.present.ds).toBe(ds);
    expect(analyzeBatch(hist.present.ds, params).probes.find((x) => x.id === "p3")).toEqual(beforeP3);
    expect(hist.future).toHaveLength(1);

    // 重做 → 再次应用
    hist = redo(hist);
    expect(hist.present.ds).toEqual(fixed);
    expect(hist.future).toHaveLength(0);
  });

  it("停用候选采用后通道剔除；撤销恢复", () => {
    const ds = buildSampleDataset();
    const params = { ...P, driftBias: 2, targetF0: 1, maxGapSec: 90 };
    const before = analyzeBatch(ds, params);
    expect(before.verdict).toBe("block");

    let hist = initHistory(ds);
    const disabled = applyAdjustments(ds, { p6: { offsetSeconds: 0, disabled: true } });
    hist = pushState(hist, disabled, "停用 P6");
    expect(disabled.channels.some((c) => c.id === "p6")).toBe(false);

    hist = undo(hist);
    expect(hist.present).toBe(ds);
    hist = redo(hist);
    expect(hist.present).toEqual(disabled);
  });
});
