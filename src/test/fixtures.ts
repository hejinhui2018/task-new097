import type { Channel, Dataset, RawSample, Settings } from '../types';

// 测试用确定性工艺仿真（与示例数据同源但可参数化），时间单位 ms。
export const CAME_UP = 25 * 60_000;
export const HOLD = 50 * 60_000;
export const END = 75 * 60_000;

const STEPS = [20, 25, 15, 20, 30];

const smooth = (x: number) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};

function retortTemp(t: number): number {
  if (t < CAME_UP) return 25 + (121.1 - 25) * smooth(t / CAME_UP);
  if (t < HOLD) return 121.1 + 0.25 * Math.sin(t / 120_000);
  if (t < END) return 121.1 + (35 - 121.1) * smooth((t - HOLD) / (END - HOLD));
  return 32;
}

export interface ProbeOpts {
  lag?: number;
  tau?: number;
  offset?: number;
  /** 整体时钟错位 ms（读数时间戳整体平移） */
  shiftMs?: number;
  /** 保温段额外持续偏冷 °C（传感器漂移） */
  driftCold?: number;
  /** 在 [dropFrom, dropTo)（ms，未平移坐标）内丢点 */
  drop?: { from: number; to: number };
  /** 提前结束采集的时刻（未平移坐标） */
  stopAt?: number;
  /** 将第 n 个采样点时间回退 45 s（时钟倒退，大于任意采样节拍） */
  regressAtStep?: number;
}

function buildProbe(opts: ProbeOpts = {}): RawSample[] {
  const lag = opts.lag ?? 0;
  const tau = opts.tau ?? 45;
  const offset = opts.offset ?? -0.1;
  const out: RawSample[] = [];
  let t = 0;
  let Tp = 25;
  let i = 0;
  while (t <= END) {
    const dtSec = STEPS[i % STEPS.length];
    const env = retortTemp(Math.max(0, t - lag * 1000));
    const target = env + offset * smooth((env - 85) / 25) - (opts.driftCold ?? 0) * smooth((t - CAME_UP) / 300_000);
    Tp = Tp + (target - Tp) * (1 - Math.exp(-dtSec / tau));
    let stamped = t + (opts.shiftMs ?? 0);
    if (opts.regressAtStep !== undefined && i === opts.regressAtStep) stamped -= 45_000;
    const dropped = opts.drop && t >= opts.drop.from && t < opts.drop.to;
    out.push({ t: stamped, temp: dropped ? null : Math.round(Tp * 100) / 100 });
    if (opts.stopAt !== undefined && t >= opts.stopAt) break;
    t += dtSec * 1000;
    i++;
  }
  return out;
}

export function makeDataset(probeOpts: ProbeOpts[] = [{}, {}, {}, {}, {}, {}]): Dataset {
  const retortSamples: RawSample[] = [];
  let t = 0;
  let i = 0;
  while (t <= END) {
    retortSamples.push({ t, temp: Math.round(retortTemp(t) * 100) / 100 });
    t += STEPS[i % STEPS.length] * 1000;
    i++;
  }
  const channels: Channel[] = [
    { id: 'retort', name: '釜温', kind: 'retort', samples: retortSamples },
    ...probeOpts.map((o, idx) => ({
      id: `p${idx + 1}`,
      name: `P${idx + 1}`,
      kind: 'probe' as const,
      samples: buildProbe(o),
    })),
  ];
  return { channels };
}

export function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    refTemp: 121.1,
    zValue: 10,
    targetF0: 6,
    maxGapSeconds: 60,
    holdTemp: 120,
    holdStart: CAME_UP,
    holdEnd: HOLD,
    driftC: 1.5,
    ...over,
  };
}

/** 简单线性温度斜坡采样（用于积分数学验证） */
export function linearRamp(timesSec: number[], t1C: number, t2C: number, spanSec = 600): RawSample[] {
  return timesSec.map((s) => ({ t: s * 1000, temp: t1C + ((t2C - t1C) * s) / spanSec }));
}

export function flatSamples(timesSec: number[], c: number): RawSample[] {
  return timesSec.map((s) => ({ t: s * 1000, temp: c }));
}
