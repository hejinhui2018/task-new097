import { describe, it, expect } from 'vitest';
import { parseCsv, parseTime } from '../lib/csv';
import { detectHoldStages } from '../lib/stages';
import { buildSegments } from '../lib/segments';
import { CAME_UP, HOLD } from './fixtures';

describe('CSV 导入', () => {
  it('解析表头、多通道、空单元缺测、mm:ss 与秒时间', () => {
    const csv = [
      '时间,釜温,探针A,探针B',
      '00:00,25.0,25.1,25.0',
      '00:30,40.2,,26.3',
      '90,80,79.5,',
    ].join('\n');
    const { dataset, warnings } = parseCsv(csv);
    expect(warnings).toHaveLength(0);
    expect(dataset.channels).toHaveLength(3);
    expect(dataset.channels[0].kind).toBe('retort');
    expect(dataset.channels[1].kind).toBe('probe');
    const a = dataset.channels[1];
    expect(a.samples.map((s) => s.t)).toEqual([0, 30_000, 90_000]);
    expect(a.samples[1].temp).toBeNull();
    expect(a.samples[2].temp).toBeCloseTo(79.5);
    // 第三支探针最后一个空单元也是缺测而非 0
    expect(dataset.channels[2].samples[2].temp).toBeNull();
  });

  it('表头含 retort 识别为釜温；非法温度按缺测并告警', () => {
    const csv = ['t,retort-1,p1', '0,25,25', '30,bad,30'].join('\n');
    const { dataset, warnings } = parseCsv(csv);
    expect(dataset.channels[0].kind).toBe('retort');
    expect(dataset.channels[0].samples[1].temp).toBeNull();
    expect(dataset.channels[1].samples[1].temp).toBe(30);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('没有釜温列时第一温度列作为釜温', () => {
    const { dataset } = parseCsv('t,a,b\n0,1,2\n30,3,4');
    expect(dataset.channels[0].kind).toBe('retort');
    expect(dataset.channels[1].kind).toBe('probe');
  });

  it('时间解析支持秒、mm:ss、hh:mm:ss', () => {
    expect(parseTime('90')).toBe(90_000);
    expect(parseTime('01:30')).toBe(90_000);
    expect(parseTime('1:00:00')).toBe(3600_000);
    expect(parseTime('')).toBeNull();
    expect(parseTime('abc')).toBeNull();
  });

  it('空内容抛错', () => {
    expect(() => parseCsv('only,header')).toThrow();
  });
});

describe('保温段自动识别', () => {
  it('从仿真釜温识别出保温开始/结束（误差 ≤ 30 s）', () => {
    // 用与夹具相同的构造方式生成釜温
    const STEPS = [20, 25, 15, 20, 30];
    const smooth = (x: number) => {
      const u = Math.min(1, Math.max(0, x));
      return u * u * (3 - 2 * u);
    };
    const END = 75 * 60_000;
    const rt = (t: number) => {
      if (t < CAME_UP) return 25 + (121.1 - 25) * smooth(t / CAME_UP);
      if (t < HOLD) return 121.1 + 0.2 * Math.sin(t / 120_000);
      if (t < END) return 121.1 + (35 - 121.1) * smooth((t - HOLD) / (END - HOLD));
      return 32;
    };
    const samples = [];
    let t = 0;
    let i = 0;
    while (t <= END) {
      samples.push({ t, temp: rt(t) });
      t += STEPS[i % STEPS.length] * 1000;
      i++;
    }
    const built = buildSegments(samples, 60_000);
    const { holdStart, holdEnd } = detectHoldStages(built.segments, 120);
    // 期望边界 = 釜温首次/末次持续跨过 120 °C 的时刻（早于/晚于名义边界，按 5s 网格计算）
    const cross = (up: boolean) => {
      for (let tt = 0; tt <= END; tt += 5_000) {
        const hot = rt(tt) >= 120;
        if (up ? hot : !hot && tt > CAME_UP) return tt;
      }
      return null;
    };
    const expStart = cross(true)!;
    let expEnd = null;
    for (let tt = HOLD; tt <= END; tt += 5_000) {
      if (rt(tt) < 120) {
        expEnd = tt;
        break;
      }
    }
    expect(holdStart).not.toBeNull();
    expect(holdEnd).not.toBeNull();
    expect(Math.abs(holdStart! - expStart)).toBeLessThanOrEqual(10_000);
    expect(Math.abs(holdEnd! - expEnd!)).toBeLessThanOrEqual(10_000);
  });

  it('从未达到保温温度返回 null', () => {
    const built = buildSegments(
      [0, 30, 60, 90].map((s) => ({ t: s * 1000, temp: 25 + s * 0.1 })),
      60_000,
    );
    expect(detectHoldStages(built.segments, 120)).toEqual({ holdStart: null, holdEnd: null });
  });
});
