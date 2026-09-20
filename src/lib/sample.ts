/**
 * 内置示例：1 路釜温 + 6 支罐内探针，900s 升温 / 2400s 保温 / 1200s 降温。
 * 故意植入的数据问题（用于演示门禁与候选，不做任何掩盖）：
 *  - P3 时钟整体错位 +60s（两端额外各延伸 60s，窗口仍覆盖）→ 校时候选
 *  - P5 升温段 90s 短缺测（恰为允许上限，警告但可插值）
 * *  - P6 为快热罐位但保温段读数系统性偏高约 2.5℃、甚至高于釜温 → 疑似正漂移，阻断其结论 → 停用候选
 */
import type { ChannelDef, Dataset, Sample, StageDef } from "../types";

export const SAMPLE_STAGES: StageDef[] = [
  { id: "st-comeup", name: "升温", kind: "comeup", start: 0, end: 900 },
  { id: "st-holding", name: "保温", kind: "holding", start: 900, end: 3300 },
  { id: "st-cooling", name: "降温", kind: "cooling", start: 3300, end: 4500 },
];

/** 釜温设定曲线 */
function retortTemp(t: number): number {
  if (t < 0) return 35;
  if (t <= 900) return 35 + 86.2 * Math.pow(t / 900, 1.55);
  if (t <= 3300) return 121.4 + 0.15 * Math.sin(t / 220);
  if (t <= 4500) return 121.4 - 83.4 * Math.pow((t - 3300) / 1200, 1.35);
  return 38;
}

/** 一阶惯性：探针温度跟随釜温，τ 越大升温越慢（罐位越难加热） */
function lagResponse(times: number[], tauHeat: number, tauCool: number, bias: number): number[] {
  const out: number[] = [];
  let temp = 35;
  for (let i = 0; i < times.length; i++) {
    if (i === 0) {
      temp = 35;
    } else {
      const dt = times[i] - times[i - 1];
      const target = retortTemp(times[i]);
      const tau = target >= temp ? tauHeat : tauCool;
      temp += (1 - Math.exp(-dt / tau)) * (target - temp);
    }
    out.push(temp + bias);
  }
  return out;
}

function jitter(k: number, seed: number): number {
  // 确定性伪随机抖动（±5s 内），避免每次加载数据不同
  const x = Math.sin(k * 127.1 + seed * 311.7) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 10;
}

function buildProbe(index: number): ChannelDef {
  const isP3 = index === 3;
  const isP5 = index === 5;
  const isP6 = index === 6;
  // P3 时钟错位：采样轴整体 +60s，两端各多采 60s
  const tStart = isP3 ? -60 : 0;
  const tEnd = isP3 ? 4560 : 4500;
  const clockOffset = isP3 ? 60 : 0;
  const tauH = isP6 ? 62 : 95 + index * 16; // P1 111s … P5 175s；P6 本应是快热罐位（贴壁）
  const tauC = tauH * 1.9;
  const bias = isP6 ? 2.5 : 0;

  // 采样时刻（标称 30s 间隔 + 确定性抖动）；P5 删除标称 450/480 两点
  const pairs: { nom: number; t: number }[] = [];
  for (let t = tStart; t <= tEnd; t += 30) {
    if (isP5 && (t === 450 || t === 480)) continue;
    pairs.push({ nom: t, t: t + jitter(t / 30, index) });
  }
  const filtered = pairs.map((x) => x.t);
  const temps = lagResponse(filtered, tauH, tauC, 0).map((tmp, i) => {
    const real = filtered[i] + clockOffset;
    // P6 漂移只发生在保温段
    return tmp + (isP6 && real >= 880 && real <= 3320 ? bias : 0);
  });
  const samples: Sample[] = filtered.map((tt, i) => ({
    t: Math.round((tt + clockOffset) * 10) / 10,
    temp: Math.round(temps[i] * 100) / 100,
  }));
  // 首末采样钉到标称边界，避免抖动把末点拉进窗口内造成假的“未覆盖”
  samples[0].t = tStart + clockOffset;
  samples[samples.length - 1].t = tEnd + clockOffset;
  if (isP5) {
    // 缺口两端钉到 420/510（消除抖动），恰好 90s = 允许缺测上限
    for (const target of [420, 510]) {
      const i = pairs.findIndex((x) => x.nom === target);
      if (i >= 0) samples[i].t = target;
    }
  }
  return {
    id: `p${index}`,
    name: `探针 P${index}`,
    role: "probe",
    samples,
  };
}

function buildRetort(): ChannelDef {
  const samples: Sample[] = [];
  for (let t = 0; t <= 4500; t += 15) {
    samples.push({ t, temp: Math.round(retortTemp(t) * 100) / 100 });
  }
  return { id: "retort", name: "釜温 RT", role: "retort", samples };
}

export function buildSampleDataset(): Dataset {
  return {
    id: "sample-builtin",
    name: "示例批 · 六探针（含短缺测 / 漂移 / 时钟错位）",
    importedAt: 0,
    channels: [buildRetort(), buildProbe(1), buildProbe(2), buildProbe(3), buildProbe(4), buildProbe(5), buildProbe(6)],
    stages: SAMPLE_STAGES,
  };
}
