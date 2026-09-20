import type { Channel, Dataset, RawSample } from '../types';

// 确定性示例：1 路釜温 + 6 支探针，相对时间（ms），不规则采样。
// P4 为本批冷点；P5 保温中有一次短缺测（允许插值，留证）；P6 保温段疑似漂移（门禁阻止）。

const T0 = 0;
const COME_UP_END = 25 * 60_000;
const HOLD_END = 50 * 60_000;
const COOL_END = 75 * 60_000;

const smooth = (x: number) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};

function retortTemp(t: number): number {
  if (t < COME_UP_END) {
    return 25 + (121.1 - 25) * smooth(t / COME_UP_END);
  }
  if (t < HOLD_END) {
    return 121.1 + 0.3 * Math.sin(t / 120_000);
  }
  if (t < COOL_END) {
    return 121.1 + (35 - 121.1) * smooth((t - HOLD_END) / (COOL_END - HOLD_END));
  }
  return 32;
}

interface ProbeProfile {
  lag: number; // 热响应滞后 s
  tau: number; // 一阶热时间常数 s
  plateauOffset: number; // 高温段相对釜温的稳定偏差 °C（负值=更冷）
}

const PROFILES: ProbeProfile[] = [
  { lag: 95, tau: 55, plateauOffset: -0.1 },
  { lag: 105, tau: 62, plateauOffset: -0.5 },
  { lag: 112, tau: 70, plateauOffset: -1.7 }, // P3：几何冷点
  { lag: 118, tau: 66, plateauOffset: -0.9 },
  { lag: 92, tau: 58, plateauOffset: -0.4 }, // P5：短缺测
  { lag: 108, tau: 64, plateauOffset: -0.7 }, // P6：漂移
];

// 确定性不规则节拍（s）：20/25/15/20/30 循环
const STEP_PATTERN = [20, 25, 15, 20, 30];

function buildProbe(index: number): RawSample[] {
  const p = PROFILES[index];
  const samples: RawSample[] = [];
  let t = T0;
  let Tp = 25;
  let stepIdx = 0;
  while (t <= COOL_END) {
    // 一阶热惯性：向滞后后的环境温度指数趋近
    const envRetort = retortTemp(Math.max(0, t - p.lag * 1000));
    const hotBlend = smooth((envRetort - 85) / 25);
    const target = envRetort + p.plateauOffset * hotBlend;
    const dtSec = STEP_PATTERN[stepIdx % STEP_PATTERN.length];
    Tp = Tp + (target - Tp) * (1 - Math.exp(-dtSec / p.tau));

    let temp: number | null = Tp;
    // P5：保温第 10 分钟附近丢一个采样点（与相邻点形成 ~45 s 短缺口）
    if (index === 4 && t >= HOLD_END - 15 * 60_000 && t < HOLD_END - 15 * 60_000 + 30_000) {
      temp = null;
    }
    // P6：保温开始后持续走冷，累计 -2.6 °C（超过漂移阈值）
    if (index === 5 && t > COME_UP_END) {
      temp = temp === null ? null : temp - 2.6 * smooth((t - COME_UP_END) / (10 * 60_000));
    }
    samples.push({ t, temp: temp === null ? null : Math.round(temp * 100) / 100 });
    t += dtSec * 1000;
    stepIdx++;
  }
  return samples;
}

export const SAMPLE_STAGE = {
  holdStart: COME_UP_END,
  holdEnd: HOLD_END,
  processEnd: COOL_END,
};

export function buildSampleDataset(): Dataset {
  const channels: Channel[] = [];

  // 釜温通道使用同一不规则时间网格
  const retortSamples: RawSample[] = [];
  {
    let t = T0;
    let stepIdx = 0;
    while (t <= COOL_END) {
      retortSamples.push({ t, temp: Math.round(retortTemp(t) * 100) / 100 });
      t += STEP_PATTERN[stepIdx % STEP_PATTERN.length] * 1000;
      stepIdx++;
    }
  }
  channels.push({ id: 'retort-1', name: '釜温 RT', kind: 'retort', samples: retortSamples });

  for (let i = 0; i < PROFILES.length; i++) {
    channels.push({
      id: `probe-${i + 1}`,
      name: `探针 P${i + 1}`,
      kind: 'probe',
      samples: buildProbe(i),
    });
  }
  return { channels };
}
