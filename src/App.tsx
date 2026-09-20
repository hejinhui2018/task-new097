import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Adjustments, Settings } from './types';
import { reducer, initState, DEFAULT_SETTINGS } from './lib/state';
import { persistState, loadPersisted, clearPersisted } from './lib/storage';
import { analyze } from './lib/analyze';
import { buildSampleDataset, SAMPLE_STAGE } from './lib/sampleData';
import { parseCsv } from './lib/csv';
import { buildSegments } from './lib/segments';
import { detectHoldStages } from './lib/stages';
import { ProcessChart } from './components/Chart';
import { Ranking } from './components/Ranking';
import { Findings } from './components/Findings';
import { CursorTable } from './components/CursorTable';
import { Candidates } from './components/Candidates';
import { SettingsPanel } from './components/SettingsPanel';
import './styles.css';

const VERDICT_META = {
  pass: { hero: '可放行', tag: '基于有效探针冷点', cls: 'pass' },
  fail: { hero: 'F0 不足', tag: '数据有效但杀菌强度未达标', cls: 'fail' },
  indeterminate: { hero: '结论悬置', tag: '存在阻止放行的证据', cls: 'indeterminate' },
} as const;

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const persisted = loadPersisted();
    if (persisted) {
      return reducer(
        initState(persisted.dataset, { ...DEFAULT_SETTINGS, ...persisted.settings }),
        { type: 'hydrate', state: persisted },
      );
    }
    return initState(buildSampleDataset(), {
      ...DEFAULT_SETTINGS,
      holdStart: SAMPLE_STAGE.holdStart,
      holdEnd: SAMPLE_STAGE.holdEnd,
    });
  });

  const [cursorT, setCursorT] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('hpr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hpr-theme', theme);
  }, [theme]);

  const analysis = useMemo(
    () => analyze(state.dataset, state.settings, state.adjustments),
    [state.dataset, state.settings, state.adjustments],
  );

  // 本地保存（任何状态变化后落盘，含撤销/重做栈）
  useEffect(() => {
    persistState(state);
  }, [state]);

  const commitSettings = (label: string, patch: Partial<Settings>) =>
    dispatch({ type: 'commit', label, patch: { settings: { ...state.settings, ...patch } } });

  const adoptAdjustments = (label: string, next: Adjustments) =>
    dispatch({ type: 'commit', label, patch: { adjustments: next } });

  const baseMs = useMemo(() => {
    const times = state.dataset.channels.flatMap((c) => c.samples.map((s) => s.t));
    return times.length ? Math.min(...times) : 0;
  }, [state.dataset]);

  const autoDetect = () => {
    const retort = analysis.channels.find((c) => c.kind === 'retort');
    if (!retort) return;
    const { holdStart, holdEnd } = detectHoldStages(retort.segments, state.settings.holdTemp);
    dispatch({
      type: 'commit',
      label: '自动识别保温段',
      patch: { settings: { ...state.settings, holdStart, holdEnd } },
    });
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const { dataset, warnings } = parseCsv(text);
      // 导入后尝试自动识别保温段；找不到则保持 null（门禁会阻止结论）
      const retortCh = dataset.channels.find((c) => c.kind === 'retort');
      let hold: { holdStart: number | null; holdEnd: number | null } = { holdStart: null, holdEnd: null };
      if (retortCh) {
        const built = buildSegments(retortCh.samples, state.settings.maxGapSeconds * 1000);
        hold = detectHoldStages(built.segments, state.settings.holdTemp);
      }
      dispatch({
        type: 'commit',
        label: `导入 ${file.name}`,
        patch: {
          dataset,
          settings: { ...state.settings, holdStart: hold.holdStart, holdEnd: hold.holdEnd },
          adjustments: { offsets: {}, disabled: {} },
        },
      });
      setHidden(new Set());
      setSelectedId(null);
      setImportMsg(
        warnings.length
          ? `已导入 ${dataset.channels.length} 个通道；${warnings.length} 条解析警告见控制台。`
          : `已导入 ${dataset.channels.length} 个通道。${
              hold.holdStart === null ? '未能自动识别保温段，请手动设定。' : '已自动识别保温段。'
            }`,
      );
      if (warnings.length) console.warn(warnings);
    } catch (e) {
      setImportMsg(`导入失败：${(e as Error).message}`);
    }
  };

  const loadSample = () => {
    dispatch({
      type: 'commit',
      label: '载入内置示例',
      patch: {
        dataset: buildSampleDataset(),
        settings: { ...DEFAULT_SETTINGS, holdStart: SAMPLE_STAGE.holdStart, holdEnd: SAMPLE_STAGE.holdEnd },
        adjustments: { offsets: {}, disabled: {} },
      },
    });
    setHidden(new Set());
    setSelectedId(null);
    setImportMsg(null);
  };

  const resetAll = () => {
    if (!window.confirm('清空本地保存并恢复内置示例？该操作不可撤销（历史将被重置）。')) return;
    clearPersisted();
    dispatch({
      type: 'commit',
      label: '清空并重置',
      patch: {
        dataset: buildSampleDataset(),
        settings: { ...DEFAULT_SETTINGS, holdStart: SAMPLE_STAGE.holdStart, holdEnd: SAMPLE_STAGE.holdEnd },
        adjustments: { offsets: {}, disabled: {} },
      },
    });
    setHidden(new Set());
  };

  const meta = VERDICT_META[analysis.verdict];
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>热穿透放行复核台</h1>
          <div className="sub">多通道时间-温度 · 真实时间轴线性插值 F0 积分 · 阶段归因 · 冷点门禁</div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => fileRef.current?.click()}>导入 CSV</button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
            e.target.value = '';
          }}
        />
        <a className="btn" href="/sample.csv" download="heat-penetration-sample.csv" title="下载示例 CSV 以验证导入">示例 CSV</a>
        <button className="btn" onClick={loadSample}>内置示例</button>
        <button className="btn" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} title="切换深色/浅色">
          {theme === 'dark' ? '☀ 浅色' : '☾ 深色'}
        </button>
        <button className="btn" disabled={!canUndo} onClick={() => dispatch({ type: 'undo' })} title="撤销上一次采用/设置">
          ↶ 撤销{canUndo ? `（${state.past.length}）` : ''}
        </button>
        <button className="btn" disabled={!canRedo} onClick={() => dispatch({ type: 'redo' })} title="重做">
          ↷ 重做{canRedo ? `（${state.future.length}）` : ''}
        </button>
        <button className="btn danger" onClick={resetAll}>清空本地</button>
      </header>

      {state.lastLabel && (
        <div className="hint" style={{ marginBottom: 8 }} role="status">
          最近操作：{state.lastLabel}
        </div>
      )}
      {importMsg && (
        <div className="hint" style={{ marginBottom: 8 }} role="status">
          {importMsg}
        </div>
      )}

      <section className={`verdict ${meta.cls}`} aria-live="polite">
        <div>
          <span className="tag">{meta.tag}</span>
          <div className="hero">{meta.hero}</div>
        </div>
        <div>
          <ul>
            {analysis.verdictReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <div className="disclaimer">
            本台仅做工程复核与证据留痕，不替代法规规定的杀菌工艺放行；任何“可放行”结论仍需由授权人员按适用法规与工艺规程签署。
          </div>
        </div>
      </section>

      <section className="card">
        <h2>复核参数与工艺阶段</h2>
        <SettingsPanel settings={state.settings} baseMs={baseMs} onPatch={commitSettings} onAutoDetect={autoDetect} />
      </section>

      <section className="card">
        <h2>过程曲线与累计 F0（移动指针查看各通道瞬时致死率与累计贡献）</h2>
        <ProcessChart
          analysis={analysis}
          refTemp={state.settings.refTemp}
          zValue={state.settings.zValue}
          targetF0={state.settings.targetF0}
          hidden={hidden}
          selectedId={selectedId}
          cursorT={cursorT}
          onCursor={setCursorT}
        />
        <div className="legend">
          {analysis.channels.map((ch) => (
            <span
              key={ch.id}
              className={`item${hidden.has(ch.id) ? ' dimmed' : ''}`}
              onClick={() => {
                toggleHidden(ch.id);
                setSelectedId((s) => (s === ch.id ? null : s));
              }}
              title="点击隐藏/显示；在排行表点击可高亮单通道"
            >
              <span
                className={`key${ch.kind === 'retort' ? ' dashed' : ''}`}
                style={{
                  borderColor:
                    ch.kind === 'retort'
                      ? 'var(--retort)'
                      : `var(--series-${
                          analysis.channels.filter((c) => c.kind === 'probe').findIndex((c) => c.id === ch.id) + 1
                        })`,
                }}
              />
              {ch.name}
              {ch.id === analysis.coldPointId && ' · 冷点'}
            </span>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <div>
          <section className="card">
            <h2>探针排行（按累计 F0；点击行高亮曲线）</h2>
            <Ranking analysis={analysis} targetF0={state.settings.targetF0} selectedId={selectedId} onSelect={setSelectedId} />
          </section>
          <section className="card">
            <h2>游标瞬时读数{cursorT !== null ? '' : ''}</h2>
            <CursorTable analysis={analysis} t={cursorT} refTemp={state.settings.refTemp} zValue={state.settings.zValue} />
          </section>
          <section className="card">
            <h2>校时 / 停用候选比较（先影子比较，采用后可撤销重做）</h2>
            <Candidates
              analysis={analysis}
              dataset={state.dataset}
              settings={state.settings}
              adjustments={state.adjustments}
              onAdopt={adoptAdjustments}
            />
          </section>
        </div>
        <div>
          <section className="card">
            <h2>偏差证据（block 阻止相关结论，warn 留证）</h2>
            <Findings analysis={analysis} />
          </section>
        </div>
      </div>

      <footer className="footer-note">
        数据与历史仅保存在本浏览器 localStorage；缺口不补零、不沿用上一温度；本台不替代法规放行。
      </footer>
    </div>
  );
}
