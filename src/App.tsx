import { useEffect, useMemo, useRef, useState } from "react";
import type { AdjustmentMap, Dataset, ProcessParams, StageDef } from "./types";
import { DEFAULT_PARAMS } from "./types";
import { analyzeBatch, applyAdjustments, suggestCandidates, trialAdjustments, stagesOrdered } from "./lib/analyze";
import { cursorRows } from "./lib/cursor";
import { buildSampleDataset } from "./lib/sample";
import { parseCsv, toCsv } from "./lib/csv";
import { initHistory, pushState, undo, redo, type History } from "./lib/history";
import ProcessChart from "./components/ProcessChart";
import { ProbeRanking, FTargetBar } from "./components/Panels";
import { EvidencePanel } from "./components/EvidencePanel";
import { CursorPanel } from "./components/CursorPanel";
import { CandidatePanel } from "./components/CandidatePanel";
import { ParamsForm, StageEditor } from "./components/Settings";
import { fmtF, fmtTemp } from "./format";

interface CoreState {
  base: Dataset;
  stages: StageDef[];
  adjustments: AdjustmentMap;
}

const STORAGE_KEY = "hp-review-v1";

function coreFromBase(base: Dataset): CoreState {
  return { base, stages: base.stages, adjustments: {} };
}

function viewDataset(core: CoreState): Dataset {
  return { ...applyAdjustments(core.base, core.adjustments), stages: core.stages };
}

const VERDICT: Record<string, { text: string; cls: string }> = {
  pass: { text: "通过（数据完整且冷点达标）", cls: "pass" },
  conditional: { text: "条件通过（冷点达标，但存在允许内缺测，须人工确认）", cls: "conditional" },
  hold: { text: "不予放行（冷点 F0 低于目标）", cls: "hold" },
  block: { text: "阻断（数据缺陷或覆盖不完整，不能据此放行）", cls: "block" },
};

export default function App() {
  const [hist, setHist] = useState(() => {
    const saved = loadHistory();
    return saved ?? initHistory<CoreState>(coreFromBase(buildSampleDataset()));
  });
  const [params, setParams] = useState<ProcessParams>(() => loadParams() ?? DEFAULT_PARAMS);
  const [theme, setTheme] = useState<"light" | "dark">(() => loadTheme());
  const [cursor, setCursor] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [trial, setTrial] = useState<AdjustmentMap | null>(null);
  const [importMsg, setImportMsg] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const core = hist.present;
  const dataset = useMemo(() => viewDataset(core), [core]);
  const result = useMemo(() => analyzeBatch(dataset, params), [dataset, params]);
  const candidates = useMemo(() => suggestCandidates(dataset, params), [dataset, params]);
  const trialDataset = useMemo(() => (trial ? { ...applyAdjustments(core.base, trial), stages: core.stages } : null), [trial, core]);
  const trialResult = useMemo(() => (trialDataset ? analyzeBatch(trialDataset, params) : null), [trialDataset, params]);
  const allAnalyses = result.retort ? [result.retort, ...result.probes] : result.probes;
  const rows = useMemo(
    () => (cursor !== null ? cursorRows(dataset.channels, cursor, result.window[0], params) : []),
    [cursor, dataset, result.window, params],
  );

  // 持久化（刷新恢复）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ hist, params, theme }));
      } catch {
        /* 配额超限时静默：本地保存失败不应阻断复核 */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [hist, params, theme]);

  // 键盘：Ctrl/Cmd+Z 撤销，Ctrl+Shift+Z 重做
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        setHist((h0) => (e.shiftKey ? redo(h0) : undo(h0)));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const commit = (next: CoreState, label: string) => {
    setHist((h0) => pushState(h0, next, label));
    setTrial(null);
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text, file.name.replace(/\.csv$/i, ""));
    if (!parsed.dataset) {
      setImportMsg(parsed.errors.length ? parsed.errors : ["无法解析该文件"]);
      return;
    }
    setImportMsg(parsed.errors);
    setHidden(new Set());
    setTrial(null);
    commit(coreFromBase(parsed.dataset), `导入 ${parsed.dataset.name}`);
  };

  const onExport = () => {
    const blob = new Blob([toCsv(dataset)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${dataset.name || "export"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const adoptTrial = () => {
    if (!trial) return;
    commit({ ...core, adjustments: trial }, "采用校时/停用候选");
  };
  const removeAdjustment = (id: string) => {
    const next = { ...core.adjustments };
    delete next[id];
    commit({ ...core, adjustments: next }, `撤销 ${id} 的处理`);
  };

  const v = VERDICT[result.verdict];
  const blockingGapCount = result.probes.reduce((n, p) => n + p.gaps.filter((g) => g.blocking).length, 0);
  const toggle = (id: string) =>
    setHidden((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const probeIndex = (id: string) => dataset.channels.filter((c) => c.role === "probe").findIndex((c) => c.id === id);

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>热穿透放行复核台</h1>
          <div className="sub">多通道 F0 积分 · 冷点识别 · 数据缺陷门禁（本地计算，数据不出浏览器）</div>
        </div>
        <div className="spacer" />
        <button onClick={() => { setHidden(new Set()); setTrial(null); commit(coreFromBase(buildSampleDataset()), "载入内置示例"); }}>
          载入示例
        </button>
        <button className="file-btn" onClick={() => fileRef.current?.click()}>
          导入 CSV
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = "";
            }}
          />
        </button>
        <button onClick={onExport}>导出 CSV</button>
        <button className="iconbtn" onClick={() => setHist(undo)} disabled={hist.past.length === 0} title="撤销 Ctrl+Z">↶ 撤销</button>
        <button className="iconbtn" onClick={() => setHist(redo)} disabled={hist.future.length === 0} title="重做 Ctrl+Shift+Z">↷ 重做</button>
        <button className="iconbtn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "浅色" : "深色"}</button>
      </header>

      {hist.past.length > 0 && (
        <div className="note" style={{ marginBottom: 8 }}>
          最近操作：{hist.past[hist.past.length - 1].label}
          {hist.future.length > 0 && ` · 可重做：${hist.future[0].label}`}
        </div>
      )}

      <div className={`verdict-banner ${v.cls}`}>
        <div className="big">{v.text}</div>
        <ul className="reasons" style={{ margin: 0, paddingLeft: 18 }}>
          {result.reasons.slice(0, 4).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {result.reasons.length === 0 &&
            (result.verdict === "conditional" ? (
              <li>各通道覆盖完整、冷点达标；存在允许内的短缺测等警告项（见“偏差证据与门禁”），须人工确认后方可放行。</li>
            ) : (
              <li>各通道覆盖完整，未触发阻断/警告条件。</li>
            ))}
        </ul>
      </div>

      <div className="tiles">
        <div className={`tile ${result.coldPoint && result.coldPoint.f >= params.targetF0 ? "good" : "bad"}`}>
          <div className="k">冷点累计 F0（min）</div>
          <div className="v">{result.coldPoint ? fmtF(result.coldPoint.f) : "—"} <small>/ 目标 {params.targetF0}</small></div>
        </div>
        <div className={`tile ${result.probes.every((p) => p.valid) ? "good" : "bad"}`}>
          <div className="k">有效探针</div>
          <div className="v">{result.probes.filter((p) => p.valid).length}<small> / {result.probes.length}</small></div>
        </div>
        <div className={`tile ${blockingGapCount === 0 ? "good" : "bad"}`}>
          <div className="k">阻断性缺口</div>
          <div className="v">{blockingGapCount}<small> 处</small></div>
        </div>
        <div className="tile">
          <div className="k">釜温保温均值 ℃</div>
          <div className="v">{fmtTemp(result.retort?.holdingMean)}</div>
        </div>
        <div className={`tile ${dataset.name.includes("示例") ? "warn" : ""}`}>
          <div className="k">当前数据集</div>
          <div className="v" style={{ fontSize: 13, paddingTop: 4 }}>{dataset.name}</div>
        </div>
      </div>

      {importMsg.length > 0 && (
        <div className="card" style={{ marginBottom: 12, borderColor: "var(--warning)" }}>
          {importMsg.map((m, i) => (
            <div key={i} className="note" style={{ color: "var(--warning)" }}>⚠ {m}</div>
          ))}
        </div>
      )}

      <div className="grid main">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="card">
            <h2>
              过程曲线与累计 F0
              <span className="hint">上：温度（虚线为釜温，点线 Tref）；下：各探针累计 F0 与目标线；移动鼠标查看游标</span>
            </h2>
            <ProcessChart
              channels={dataset.channels}
              analyses={allAnalyses}
              stages={stagesOrdered(dataset.stages)}
              windowV={result.window}
              params={params}
              theme={theme}
              cursor={cursor}
              onCursor={setCursor}
              hidden={hidden}
              onToggle={toggle}
            />
          </div>
          {cursor !== null && (
            <div className="card">
              <h2>游标读数 <span className="hint">瞬时致死率与累计贡献</span></h2>
              <CursorPanel rows={rows} t={cursor} theme={theme} probeIndex={probeIndex} />
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="card">
            <h2>探针排行（冷点）<span className="hint">条段为升温/保温/降温 F0 构成</span></h2>
            <ProbeRanking result={result} stages={stagesOrdered(dataset.stages)} theme={theme} hidden={hidden} onToggle={toggle} />
            <FTargetBar result={result} target={params.targetF0} />
          </div>

          <div className="card">
            <h2>校时 / 停用候选</h2>
            <CandidatePanel
              candidates={candidates}
              adjustments={core.adjustments}
              trial={trial}
              trialResult={trialResult}
              baseResult={result}
              target={params.targetF0}
              onTrial={(c) => setTrial(trialAdjustments(core.adjustments, c))}
              onClearTrial={() => setTrial(null)}
              onAdopt={adoptTrial}
              onRemove={removeAdjustment}
            />
          </div>

          <div className="card">
            <h2>偏差证据与门禁</h2>
            <EvidencePanel result={result} />
          </div>

          <div className="card">
            <h2>工艺参数</h2>
            <ParamsForm params={params} onChange={setParams} />
            <h2 style={{ marginTop: 12 }}>工艺阶段</h2>
            <StageEditor
              stages={core.stages}
              onCommit={(stages) => commit({ ...core, stages }, "修改工艺阶段")}
            />
          </div>
        </div>
      </div>

      <div className="disclaimer">
        <strong>免责声明：</strong>本工具仅用于热穿透数据的工程复核与教学演示，按所给参数与数据计算，不对数据真实性负责。
        F0 计算、冷点判定与门禁结论<strong>不能替代</strong>法规要求的正式杀菌规程放行、计量校准记录、偏差处置程序与具备资质人员的签署。
        任何异常批次必须按企业 HACCP/食品安全管理体系与适用法规（如 GB 4789、21 CFR Part 113/114 等）处理。
      </div>
    </div>
  );
}

function loadHistory(): History<CoreState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    const h = j?.hist;
    if (!h?.present?.base?.channels || !Array.isArray(h.present.stages) || !Array.isArray(h.past) || !Array.isArray(h.future)) {
      return null;
    }
    return h as History<CoreState>;
  } catch {
    return null;
  }
}
function loadParams(): ProcessParams | null {
  try {
    const j = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return j?.params ? { ...DEFAULT_PARAMS, ...j.params } : null;
  } catch {
    return null;
  }
}
function loadTheme(): "light" | "dark" {
  try {
    const j = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return j?.theme === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
