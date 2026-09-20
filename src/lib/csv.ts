import type { Channel, Dataset, RawSample } from '../types';

export interface CsvImport {
  dataset: Dataset;
  /** 解析中被跳过的问题行（留证，不静默吞掉） */
  warnings: string[];
}

/**
 * 解析多通道 CSV：第一列为时间，其余每列一个通道；首行为表头。
 * 时间支持纯数字秒、mm:ss、hh:mm:ss 与 ISO 时间；空单元 = 缺测（null）。
 * 表头含“釜/retort”（不区分大小写）的列识别为釜温，其余为探针。
 */
export function parseCsv(text: string): CsvImport {
  const warnings: string[] = [];
  const rows = splitRows(text);
  if (rows.length < 2) throw new Error('CSV 至少需要表头行与一行数据');

  const header = splitCsvLine(rows[0]).map((h) => h.trim());
  if (header.length < 2) throw new Error('CSV 至少需要时间列与一个温度通道列');

  const names = header.slice(1);
  const channels: Channel[] = names.map((name, i) => ({
    id: `csv-${i + 1}`,
    name: name || `通道 ${i + 1}`,
    kind: /釜|retort|kill/i.test(name) ? ('retort' as const) : ('probe' as const),
    samples: [] as RawSample[],
  }));
  // 没有釜温列时，第一列温度通道作为釜温
  if (!channels.some((c) => c.kind === 'retort')) channels[0].kind = 'retort';

  for (let r = 1; r < rows.length; r++) {
    const cells = splitCsvLine(rows[r]);
    if (cells.length === 0 || cells.every((c) => c.trim() === '')) continue;
    const t = parseTime(cells[0]?.trim() ?? '');
    if (t === null) {
      warnings.push(`第 ${r + 1} 行时间无法识别，已跳过：${cells[0] ?? ''}`);
      continue;
    }
    for (let i = 0; i < channels.length; i++) {
      const raw = cells[i + 1]?.trim() ?? '';
      if (raw === '') {
        channels[i].samples.push({ t, temp: null });
        continue;
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        warnings.push(`第 ${r + 1} 行「${channels[i].name}」温度非法（${raw}），按缺测处理`);
        channels[i].samples.push({ t, temp: null });
        continue;
      }
      channels[i].samples.push({ t, temp: v });
    }
  }

  for (const ch of channels) {
    if (ch.samples.length === 0) warnings.push(`通道「${ch.name}」没有任何数据行`);
  }
  return { dataset: { channels }, warnings };
}

function splitRows(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '');
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 解析时间为毫秒：数字（秒）、mm:ss、hh:mm:ss、ISO */
export function parseTime(s: string): number | null {
  if (s === '') return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    const c = clock[3] === undefined ? null : Number(clock[3]);
    if (c === null) return (a * 60 + b) * 1000;
    return (a * 3600 + b * 60 + c) * 1000;
  }
  const iso = Date.parse(s);
  return Number.isNaN(iso) ? null : iso;
}
