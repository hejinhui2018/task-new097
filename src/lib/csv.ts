/**
 * CSV 导入/导出。
 * 宽表格式：首列为时间，其余每列一个通道：
 *
 *   time,釜温 RT,P1,P2
 *   0,35.0,35.1,35.0
 *   0:15,41.2,...
 *
 * 时间支持秒数（4500）与 mm:ss / hh:mm:ss。
 * 列名含「釜温/retort/rt」（不区分大小写）的通道识别为釜温，其余为探针。
 */
import type { ChannelDef, Dataset, Sample } from "../types";

export function parseTime(token: string): number | null {
  const s = token.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map((x) => x.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const numRe = /^-?\d+(\.\d+)?$/;
  if (parts.some((p, i) => !(i === 0 ? numRe.test(p) : /^\d+(\.\d+)?$/.test(p)))) return null;
  const nums = parts.map(Number);
  const negative = s.startsWith("-");
  nums[0] = Math.abs(nums[0]);
  let sec = 0;
  if (nums.length === 2) sec = nums[0] * 60 + nums[1];
  else sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
  return negative ? -sec : sec;
}

function isRetortName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.includes("釜温") || n === "rt" || n.includes("retort");
}

export interface ParseOutcome {
  dataset?: Dataset;
  errors: string[];
}

export function parseCsv(text: string, name = "导入数据"): ParseOutcome {
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) return { errors: ["CSV 至少需要表头与两行数据"] };

  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim().replace(/^"|"$/g, ""));
  };

  const header = split(lines[0]);
  if (header.length < 2) return { errors: ["表头至少需要时间列与一个通道列"] };
  const names = header.slice(1);
  const channels: ChannelDef[] = names.map((n, i) => ({
    id: `ch-${i}`,
    name: n || `通道 ${i + 1}`,
    role: isRetortName(n) ? ("retort" as const) : ("probe" as const),
    samples: [] as Sample[],
  }));

  let badRows = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = split(lines[r]);
    const t = parseTime(cells[0]);
    if (t === null) {
      badRows++;
      continue;
    }
    for (let c = 0; c < channels.length; c++) {
      const v = cells[c + 1];
      if (v === undefined || v === "") continue; // 缺测：掉线时刻不产生采样
      const temp = Number(v);
      if (!Number.isFinite(temp)) continue;
      channels[c].samples.push({ t, temp });
    }
  }
  if (badRows) errors.push(`${badRows} 行时间无法解析，已跳过`);
  const usable = channels.filter((c) => c.samples.length >= 2);
  if (usable.length < channels.length) errors.push(`${channels.length - usable.length} 个通道有效采样不足，已保留但无法成线`);
  if (usable.length === 0) return { errors: [...errors, "没有任何可用通道"] };

  // 保证首个釜温列 id 稳定为 retort
  const retortIdx = channels.findIndex((c) => c.role === "retort");
  if (retortIdx > 0) {
    const [rt] = channels.splice(retortIdx, 1);
    channels.unshift(rt);
  }
  channels.forEach((c, i) => (c.id = c.role === "retort" ? "retort" : `p${i}`));

  const maxT = Math.max(...channels.map((c) => c.samples[c.samples.length - 1]?.t ?? 0));
  const stages = defaultStages(maxT);
  return {
    dataset: {
      id: `csv-${Date.now()}`,
      name,
      importedAt: Date.now(),
      channels,
      stages,
    },
    errors,
  };
}

/** 无阶段信息时给一个 1/3 升温、1/2 保温、1/6 降温的占位，用户必须核对修改 */
export function defaultStages(maxT: number) {
  const a = Math.round(maxT / 5);
  const b = Math.round((maxT * 5) / 6);
  return [
    { id: "st-comeup", name: "升温", kind: "comeup" as const, start: 0, end: a },
    { id: "st-holding", name: "保温", kind: "holding" as const, start: a, end: b },
    { id: "st-cooling", name: "降温", kind: "cooling" as const, start: b, end: maxT },
  ];
}

export function toCsv(dataset: Dataset): string {
  const allT = Array.from(new Set(dataset.channels.flatMap((c) => c.samples.map((s) => s.t)))).sort((a, b) => a - b);
  const header = ["time", ...dataset.channels.map((c) => c.name)];
  const rows = [header.join(",")];
  for (const t of allT) {
    const cells = [String(Math.round(t * 10) / 10)];
    for (const c of dataset.channels) {
      const hit = c.samples.find((s) => s.t === t);
      cells.push(hit ? String(hit.temp) : "");
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
}
