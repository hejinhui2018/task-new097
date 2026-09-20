import { describe, it, expect } from "vitest";
import { parseCsv, parseTime, toCsv, defaultStages } from "./csv";
import { analyzeBatch } from "./analyze";

describe("CSV 导入", () => {
  it("解析秒与 mm:ss 时间、识别釜温列、空单元格视为掉线", () => {
    const csv = [
      "time,釜温RT,P1,P2",
      "0,35,35,35",
      "0:30,60,50,51",
      "60,80,,52",
      "1:30,100,70,72",
    ].join("\n");
    const out = parseCsv(csv, "t");
    expect(out.errors).toEqual([]);
    const ds = out.dataset!;
    expect(ds.channels).toHaveLength(3);
    expect(ds.channels[0].role).toBe("retort");
    expect(ds.channels[1].samples).toHaveLength(3); // P1 在 60s 缺失
    expect(ds.channels[2].samples).toHaveLength(4);
    expect(ds.channels[0].samples[1].t).toBe(30);
    expect(ds.stages).toHaveLength(3);
  });

  it("时间倒退的 CSV 仍可导入，但分析必须阻断", () => {
    const csv = [
      "time,retort,p1",
      "0,35,35",
      "30,60,50",
      "20,80,55",
      "60,100,70",
      "90,121.1,118",
      "120,121.1,118",
    ].join("\n");
    const ds = parseCsv(csv).dataset!;
    const r = analyzeBatch({ ...ds, stages: defaultStages(120) }, {
      refTemp: 121.1, zValue: 10, targetF0: 1, maxGapSec: 90, driftBias: 2,
    });
    expect(r.probes.some((p) => p.defects.some((d) => d.code === "time-reversal"))).toBe(true);
    expect(r.verdict).toBe("block");
  });

  it("parseTime 支持 hh:mm:ss 与负数", () => {
    expect(parseTime("4500")).toBe(4500);
    expect(parseTime("1:15:00")).toBe(4500);
    expect(parseTime("1:30")).toBe(90);
    expect(parseTime("-0:45")).toBe(-45);
    expect(parseTime("abc")).toBeNull();
  });

  it("导出后再导入，F0 结论一致", () => {
    const csv = [
      "time,釜温,p1",
      ...Array.from({ length: 25 }, (_, i) => `${i * 30},${i < 4 ? 40 + i * 20 : i < 20 ? 121.2 : Math.max(40, 121.2 - (i - 20) * 6)},${i < 4 ? 35 + i * 20 : i < 20 ? 120.5 : Math.max(38, 120.5 - (i - 20) * 6)}`),
    ].join("\n");
    const ds1 = parseCsv(csv).dataset!;
    const params = { refTemp: 121.1, zValue: 10, targetF0: 5, maxGapSec: 90, driftBias: 2 };
    const r1 = analyzeBatch(ds1, params);
    const ds2 = parseCsv(toCsv(ds1)).dataset!;
    const r2 = analyzeBatch(ds2, params);
    expect(r2.coldPoint?.f).toBeCloseTo(r1.coldPoint?.f ?? NaN, 8);
  });
});
