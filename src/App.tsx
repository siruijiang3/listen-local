import { useEffect, useRef, useState } from "react";
import {
  candidates,
  formatBytes,
  getCandidate,
  modelBytes,
  revisionOf,
  defaultVoices,
  defaultSelection,
  rejectedMandarinVoices,
} from "./catalog";
import { samples } from "./samples";
import { mergeWavs, wavBlob } from "./audio";
import { loadRuns, removeRun, saveRun } from "./storage";
import type {
  Backend,
  Candidate,
  EngineId,
  Language,
  Review,
  Run,
  WorkerMessage,
  Metrics,
} from "./types";

const pageHeap = () =>
  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize ?? null;
const blankReview = (): Review => ({
  naturalness: 0,
  accuracy: 0,
  comfort: 0,
  issues: [],
  note: "",
  preferred: false,
});
const issues = [
  "地方口音不接受",
  "漏读",
  "重复",
  "截断",
  "读音不准",
  "停顿异常",
  "声音不适",
  "已核对原文",
];
const seconds = (ms?: number) =>
  ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
function Icon({ name, className = "" }: { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    wave: (
      <>
        <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
      </>
    ),
    play: <path d="m9 5 11 7-11 7Z" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    book: (
      <>
        <path d="M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
      </>
    ),
    arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    history: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" />
      </>
    ),
  };
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.wave}
    </svg>
  );
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function Player({ run }: { run: Run }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let current = "";
    const audio =
      run.status === "done"
        ? mergeWavs(run.chunks.map((c) => c.blob))
        : Promise.resolve(run.chunks[0]?.blob);
    audio
      .then((blob) => {
        if (!alive || !blob) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [run.id, run.status, run.chunks.length > 0]);
  return (
    <div className="player">
      {url ? (
        <>
          <audio
            controls
            preload="metadata"
            src={url}
            aria-label={`${getCandidate(run.engineId).name} ${run.voiceId} ${run.status === "done" ? "完整试听" : "首段预览"}`}
            onPlay={(e) =>
              document.querySelectorAll("audio").forEach((a) => {
                if (a !== e.currentTarget) a.pause();
              })
            }
          />
          <div className="player-caption">
            <span>
              {run.status === "done"
                ? "完整试听 · WAV"
                : "首段预览 · 完成后更新完整音频"}
            </span>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  download(
                    await mergeWavs(run.chunks.map((c) => c.blob)),
                    `${run.engineId}-${run.voiceId}${run.status === "done" ? "" : "-partial"}.wav`,
                  );
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <Icon name="download" />
              下载{run.status === "done" ? "" : "已完成部分"}
            </button>
          </div>
        </>
      ) : (
        <span>正在准备播放…</span>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
function ReviewForm({
  run,
  onChange,
}: {
  run: Run;
  onChange: (review: Review) => void;
}) {
  const r = run.review;
  return (
    <details className="review" open={r.preferred || undefined}>
      <summary>
        记录试听评价{" "}
        <span>
          {r.preferred
            ? "已标为偏好"
            : r.note || r.naturalness
              ? "已保存"
              : "待审核"}
        </span>
      </summary>
      <div className="ratings">
        {(
          [
            ["naturalness", "自然度"],
            ["accuracy", "准确性"],
            ["comfort", "长听舒适度"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              aria-label={`${run.voiceId} ${label}`}
              value={r[key]}
              onChange={(e) =>
                onChange({ ...r, [key]: Number(e.target.value) })
              }
            >
              <option value={0}>未评分</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="issue-list">
        {issues.map((issue) => (
          <label key={issue}>
            <input
              type="checkbox"
              checked={r.issues.includes(issue)}
              onChange={(e) =>
                onChange({
                  ...r,
                  issues: e.target.checked
                    ? [...r.issues, issue]
                    : r.issues.filter((v) => v !== issue),
                })
              }
            />
            {issue}
          </label>
        ))}
      </div>
      <textarea
        aria-label={`${run.voiceId} 试听笔记`}
        value={r.note}
        placeholder="例如：第二句人名读错；句尾停顿很自然…"
        onChange={(e) => onChange({ ...r, note: e.target.value })}
      />
      <label className="prefer">
        <input
          type="checkbox"
          checked={r.preferred}
          onChange={(e) => onChange({ ...r, preferred: e.target.checked })}
        />
        我更喜欢这个声音
      </label>
    </details>
  );
}
function MetricsView({ run }: { run: Run }) {
  const m = run.metrics;
  if (!m) return null;
  return (
    <>
      <div className="metrics">
        <div>
          <span>首段可听</span>
          <strong>{seconds(m.firstChunkMs)}</strong>
        </div>
        <div>
          <span>纯生成</span>
          <strong>{seconds(m.synthesisMs)}</strong>
        </div>
        <div>
          <span>生成 / 音频时长</span>
          <strong>
            {m.audioSeconds
              ? (m.synthesisMs / 1000 / m.audioSeconds).toFixed(2) + "×"
              : "—"}
          </strong>
        </div>
      </div>
      <details className="technical">
        <summary>运行明细与诊断</summary>
        <dl>
          <dt>下载 / 缓存</dt>
          <dd>
            {formatBytes(m.downloadedBytes)} / {formatBytes(m.cachedBytes)}
          </dd>
          <dt>下载时间 / 总加载时间</dt>
          <dd>
            {seconds(m.downloadMs)} / {seconds(m.loadMs)}
          </dd>
          <dt>实际运行方式</dt>
          <dd>
            {m.backend === "webgpu"
              ? "WebGPU（部分算子可能用 CPU）"
              : "WASM / CPU"}{" "}
            · FP32
          </dd>
          <dt>生成音频</dt>
          <dd>
            {m.audioSeconds.toFixed(1)} 秒 · {m.chunks} 段
          </dd>
          <dt>页面 JS 堆：开始 / 结束 / 峰值</dt>
          <dd>
            {m.heapStart === null
              ? "此浏览器不提供 JS 堆内存指标"
              : `${formatBytes(m.heapStart)} / ${formatBytes(m.heapEnd ?? 0)} / ${formatBytes(m.heapPeak ?? 0)}`}
          </dd>
          <dt>内存指标范围</dt>
          <dd>
            按片段采样；不含 Worker、GPU 显存和全部 WASM
            内存，不能作为总进程内存。
          </dd>
          <dt>声音 / 权重版本</dt>
          <dd>
            {run.voiceId} / {run.revision.slice(0, 8)}
          </dd>
          <dt>发音处理</dt>
          <dd>{run.frontend}</dd>
          <dt>设备记录</dt>
          <dd>{run.device}</dd>
        </dl>
        {run.chunks.flatMap((c) => c.warnings).length > 0 && (
          <p className="error">
            {[...new Set(run.chunks.flatMap((c) => c.warnings))].join("；")}
          </p>
        )}
        <p>漏读、重复与发音准确性需要对照原文人工审核，未自动判定合格。</p>
      </details>
    </>
  );
}

export default function App() {
  const [language, setLanguage] = useState<Language>("zh");
  const [sampleId, setSampleId] = useState("zh-story");
  const [text, setText] = useState(samples[0].text);
  const [selected, setSelected] = useState<EngineId[]>(defaultSelection("zh"));
  const [voices, setVoices] = useState<Record<string, string>>(defaultVoices);
  const [runs, setRuns] = useState<Run[]>([]);
  const runsRef = useRef<Run[]>([]);
  const [boot, setBoot] = useState(true);
  const [backend, setBackend] = useState<Backend>("auto");
  const [active, setActive] = useState<EngineId | null>(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<{
    loaded: number;
    total?: number;
    file?: string;
  } | null>(null);
  const [storageError, setStorageError] = useState("");
  const [view, setView] = useState<"lab" | "history">("lab");
  const [settings, setSettings] = useState(false);
  const [modelCache, setModelCache] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef(false);
  const runningRef = useRef(false);
  const resolver = useRef<(() => void) | null>(null);
  const activeId = useRef<string | null>(null);
  const currentSample = samples.find((s) => s.id === sampleId);
  const visible = candidates
    .filter((c) => c.voices.some((v) => v.language === language))
    .sort((a, b) =>
      language === "zh"
        ? Number(b.id === "kokoro-zh") - Number(a.id === "kokoro-zh")
        : 0,
    );
  useEffect(() => {
    let alive = true;
    loadRuns()
      .then((r) => {
        if (alive) {
          runsRef.current = r;
          setRuns(r);
        }
      })
      .catch(() =>
        setStorageError(
          "本地历史存储不可用；本次仍可试听，请及时导出审核记录。",
        ),
      )
      .finally(() => {
        if (alive) setBoot(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
    },
    [],
  );
  function putRun(run: Run) {
    const list = [run, ...runsRef.current.filter((r) => r.id !== run.id)].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
    runsRef.current = list;
    setRuns(list);
    saveRun(run).catch(() =>
      setStorageError(
        "保存失败，可能是本地空间不足。当前音频仍可下载；请导出记录或删除旧试听。",
      ),
    );
  }
  function updateRun(id: string, change: Partial<Run>) {
    const old = runsRef.current.find((r) => r.id === id);
    if (old) putRun({ ...old, ...change });
  }
  function chooseLanguage(lang: Language) {
    setLanguage(lang);
    const sample = samples.find((s) => s.language === lang)!;
    setSampleId(sample.id);
    setText(sample.text);
    setSelected(defaultSelection(lang));
    setVoices((v) => ({
      ...v,
      "kokoro-v1": lang === "zh" ? defaultVoices["kokoro-v1"] : "af_heart",
    }));
  }
  function stop() {
    abortRef.current = true;
    workerRef.current?.terminate();
    workerRef.current = null;
    if (activeId.current)
      updateRun(activeId.current, {
        status: "cancelled",
        error: "已停止。已完成片段可播放和下载。",
      });
    resolver.current?.();
  }
  async function start(ids: EngineId[]) {
    if (
      runningRef.current ||
      !text.trim() ||
      !ids.length ||
      text.length > 12000
    )
      return;
    runningRef.current = true;
    abortRef.current = false;
    const snapshot = text;
    const sampleName =
      sampleId === "custom"
        ? "自定义文本"
        : (currentSample?.title ?? "自定义文本");
    try {
      for (const engineId of ids) {
        if (abortRef.current) break;
        setActive(engineId);
        setProgress(null);
        setStatus("准备加载…");
        const c = getCandidate(engineId);
        const id = crypto.randomUUID();
        activeId.current = id;
        const heapStart = pageHeap();
        let heapPeak = heapStart;
        const observed = (m: Metrics): Metrics => {
          const h = pageHeap();
          if (h !== null) heapPeak = Math.max(heapPeak ?? 0, h);
          return { ...m, heapStart, heapEnd: h, heapPeak };
        };
        const device = `${navigator.userAgent}; logical CPUs=${navigator.hardwareConcurrency ?? "unknown"}; deviceMemory=${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? "unknown"} GB (browser estimate)`;
        putRun({
          id,
          engineId,
          voiceId: voices[engineId],
          language,
          text: snapshot,
          sampleName,
          createdAt: new Date().toISOString(),
          revision: revisionOf(c),
          frontend: c.frontend,
          device,
          status: "running",
          chunks: [],
          review: blankReview(),
        });
        await new Promise<void>((resolve) => {
          resolver.current = resolve;
          const worker = new Worker(
            new URL("./engine.worker.ts", import.meta.url),
            { type: "module" },
          );
          workerRef.current = worker;
          const finish = () => {
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            resolve();
          };
          worker.onerror = (e) => {
            updateRun(id, {
              status: "error",
              error:
                e.message || "语音 Worker 运行失败，请重试或改用 CPU 模式。",
            });
            finish();
          };
          worker.onmessage = ({ data: m }: MessageEvent<WorkerMessage>) => {
            if (abortRef.current) return;
            if (m.type === "status") {
              setStatus(m.label);
              setProgress(
                m.loaded !== undefined
                  ? { loaded: m.loaded, total: m.total, file: m.file }
                  : null,
              );
            }
            if (m.type === "loaded") {
              setStatus("开始生成");
              setProgress(null);
            }
            if (m.type === "chunk") {
              const old = runsRef.current.find((r) => r.id === id)!;
              putRun({
                ...old,
                chunks: [
                  ...old.chunks,
                  {
                    blob: wavBlob(m.pcm, m.sampleRate),
                    text: m.text,
                    seconds: m.pcm.length / m.sampleRate,
                    warnings: m.warnings,
                    gainDb: m.gainDb,
                  },
                ],
                metrics: observed(m.metrics),
              });
            }
            if (m.type === "done") {
              updateRun(id, { status: "done", metrics: observed(m.metrics) });
              finish();
            }
            if (m.type === "error") {
              updateRun(id, { status: "error", error: m.message });
              finish();
            }
          };
          worker.postMessage({
            type: "run",
            runId: id,
            engineId,
            voiceId: voices[engineId],
            language,
            text: snapshot,
            backend,
          });
        });
      }
    } finally {
      runningRef.current = false;
      activeId.current = null;
      resolver.current = null;
      setActive(null);
      setStatus("");
      setProgress(null);
    }
  }
  function exportReviews() {
    const records = runsRef.current.map(({ chunks, ...r }) => ({
      ...r,
      chunks: chunks.map(({ blob, ...chunk }) => ({
        ...chunk,
        bytes: blob.size,
      })),
    }));
    download(
      new Blob(
        [
          JSON.stringify(
            {
              schema: 1,
              exportedAt: new Date().toISOString(),
              normalization:
                "active RMS target -20 dBFS, peak ceiling -0.54 dBFS; not EBU R128 LUFS",
              runs: records,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "listen-lab-reviews.json",
    );
  }
  async function clearModels() {
    if (active) return;
    try {
      await caches.delete("listen-models-v1");
      setModelCache("模型缓存已清理，试听音频和评价仍保留。");
    } catch {
      setModelCache("浏览器不允许清理缓存。");
    }
  }
  function card(c: Candidate, index: number) {
    const run = runs.find(
      (r) =>
        r.engineId === c.id &&
        r.voiceId === voices[c.id] &&
        r.frontend === c.frontend &&
        r.language === language &&
        r.text === text,
    );
    const chosen = selected.includes(c.id);
    return (
      <article key={c.id} className={`candidate ${chosen ? "chosen" : ""}`}>
        <div className="candidate-heading">
          <span className="candidate-number">0{index + 1}</span>
          <label className="check-label">
            <input
              aria-label={`选择 ${c.name} ${c.subtitle}`}
              type="checkbox"
              checked={chosen}
              disabled={!!active}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, c.id]
                    : selected.filter((id) => id !== c.id),
                )
              }
            />
            加入比较
          </label>
        </div>
        <h3>{c.name}</h3>
        <p className="candidate-subtitle">{c.subtitle}</p>
        <div className="voice-row">
          <label>
            声音
            <select
              value={voices[c.id]}
              aria-label={`${c.name} ${c.subtitle} 声音`}
              disabled={!!active}
              onChange={(e) => setVoices({ ...voices, [c.id]: e.target.value })}
            >
              {c.voices
                .filter((v) => v.language === language)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="model-meta">
          <span>{formatBytes(modelBytes(c))} 权重</span>
          <span>FP32 · 原速</span>
        </div>
        {c.id === "piper-zh" && (
          <p className="license-note">试听候选 · 数据许可待核实</p>
        )}
        {run?.chunks.length ? (
          <>
            <Player run={run} />
            <MetricsView run={run} />
          </>
        ) : (
          <div className="empty-audio">
            <Icon name="wave" />
            <p>{active === c.id ? "正在为你生成声音" : "等待第一次试听"}</p>
            <span>
              {active === c.id ? status : "用同一段文字，听见不同表达"}
            </span>
          </div>
        )}
        {active === c.id && (
          <div className="job-progress" role="status">
            <div>{status}</div>
            {progress && (
              <>
                <progress
                  value={progress.loaded}
                  max={progress.total ?? undefined}
                />
                <small>
                  {progress.file} · {formatBytes(progress.loaded)}
                  {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
                </small>
              </>
            )}
          </div>
        )}
        {run?.error && (
          <p role="alert" className="error">
            {run.error}
          </p>
        )}
        <button
          className="generate-single"
          disabled={!!active || boot || !text.trim() || text.length > 12000}
          onClick={() => start([c.id])}
        >
          <Icon name="play" />
          {run ? "重新生成" : "单独生成"}
          <span>→</span>
        </button>
        {!!run?.chunks.length && (
          <ReviewForm
            run={run}
            onChange={(review) => updateRun(run.id, { review })}
          />
        )}
        <details className="model-details">
          <summary>模型与语言说明</summary>
          <p>{c.languages}</p>
          {c.id === "piper-zh" && (
            <p>
              上游 Huayan 模型卡将训练数据许可列为
              Unknown，暂不作为已通过开源许可审核的正式选型。
            </p>
          )}
          <p>{c.frontend}</p>
          <a href={c.source} target="_blank" rel="noreferrer">
            查看模型来源 ↗
          </a>
          <p>
            版本 {revisionOf(c).slice(0, 8)} ·
            仅生成时下载。运行库、词典和音色另占空间。
          </p>
        </details>
      </article>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("lab");
          }}
        >
          <span className="brand-mark">
            <Icon name="wave" />
          </span>
          <span>
            听见<small>LISTEN LOCAL</small>
          </span>
        </a>
        <div className="sidebar-section">声音实验室</div>
        <nav>
          <button
            className={view === "lab" ? "nav-active" : ""}
            onClick={() => setView("lab")}
          >
            <Icon name="wave" />
            试听比较<span>01</span>
          </button>
          <button
            className={view === "history" ? "nav-active" : ""}
            onClick={() => setView("history")}
          >
            <Icon name="history" />
            审核记录
            <span>
              {runs
                .filter(
                  (r) =>
                    r.review.preferred || r.review.note || r.review.naturalness,
                )
                .length.toString()
                .padStart(2, "0")}
            </span>
          </button>
        </nav>
        <div className="roadmap">
          <span>接下来</span>
          <div>
            <Icon name="book" />
            电子书转有声书
          </div>
          <p>
            先找到值得长听的声音。
            <br />
            模型通过审核后再继续。
          </p>
        </div>
        <div className="local-note">
          <Icon name="lock" />
          <strong>声音留在你的设备</strong>
          <p>
            文本不上传，无需登录。
            <br />
            模型下载一次，本地运行。
          </p>
          <button onClick={() => setSettings(!settings)}>
            <Icon name="settings" />
            运行与存储设置
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            本地语音试听室 <b>/</b> {view === "lab" ? "中英文评测" : "审核记录"}
          </span>
          <button
            className="top-settings"
            aria-label="运行设置"
            onClick={() => setSettings(!settings)}
          >
            <Icon name="settings" />
            本地运行设置
          </button>
        </header>
        <div className="main-inner">
          <div className="page-heading">
            <div>
              <p className="eyebrow">LISTEN FIRST. DECIDE LATER.</p>
              <h1>
                {view === "lab"
                  ? "好声音，先听再决定。"
                  : "让每一次试听有据可查。"}
              </h1>
              <p>
                {view === "lab"
                  ? "同一段文字，比较真实听感。中文与英文优先，暂不预设胜者。"
                  : "声音、原文、运行数据和你的评价，都保存在这台设备。"}
              </p>
            </div>
            <button
              className="outline-button"
              onClick={exportReviews}
              disabled={!runs.length}
            >
              <Icon name="download" />
              导出审核记录
            </button>
          </div>
          {storageError && (
            <div className="alert" role="alert">
              {storageError}
            </div>
          )}
          {view === "lab" && language === "zh" && (
            <section className="mandarin-notice" aria-label="普通话审核要求">
              <strong>中文目标：标准普通话，无明显地方口音</strong>
              <p>
                晓北、晓妮已按你的反馈移出候选。当前声音均未通过普通话听感审核；默认先检查有官方参考样音的
                v1.1-zh，其他候选需手动加入。
              </p>
              <details>
                <summary>对照官方样音：排查音色与发音处理</summary>
                <p>
                  以下链接打开模型作者的官方样音页，需要联网，不会上传试听原文。参考录音使用不同文本、动态语速及段间静音，只用于判断音色与口音，不纳入同文本速度比较。建议用电脑浏览器打开参考页。
                </p>
                {[
                  ["zf_001", "001 · 女声"],
                  ["zm_010", "010 · 男声"],
                ].map(([id, label]) => (
                  <a
                    className="reference-audio"
                    key={id}
                    href={`https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/01e7505bd6a7a2ac4975463114c3a7650a9f7218/samples/HEARME_${id}.wav`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {label} · 打开官方参考样音 ↗
                  </a>
                ))}
                <a
                  href="https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/01e7505bd6a7a2ac4975463114c3a7650a9f7218/samples/make_zh.py"
                  target="_blank"
                  rel="noreferrer"
                >
                  官方样音的原文和生成脚本 ↗
                </a>
              </details>
            </section>
          )}
          {settings && (
            <section className="settings-panel">
              <h2>运行与存储</h2>
              <label>
                推理方式
                <select
                  value={backend}
                  disabled={!!active}
                  onChange={(e) => setBackend(e.target.value as Backend)}
                >
                  <option value="auto">
                    自动：Kokoro 优先 GPU，Piper 使用 CPU
                  </option>
                  <option value="wasm">全部使用 CPU / WASM</option>
                </select>
              </label>
              <p>
                一次只运行一个模型。首次使用需下载权重；速度取决于设备。改变运行方式后请重新生成。
              </p>
              <button
                className="outline-button"
                disabled={!!active}
                onClick={clearModels}
              >
                清理已下载的模型
              </button>
              <span role="status">{modelCache}</span>
            </section>
          )}
          {view === "lab" ? (
            <>
              <section className="text-workspace">
                <div className="section-heading">
                  <h2>
                    <span>01</span>选择试听文本
                  </h2>
                  <div className="language-switch" aria-label="文本语言">
                    <button
                      disabled={!!active}
                      className={language === "zh" ? "on" : ""}
                      onClick={() => chooseLanguage("zh")}
                    >
                      中文
                    </button>
                    <button
                      disabled={!!active}
                      className={language === "en" ? "on" : ""}
                      onClick={() => chooseLanguage("en")}
                    >
                      English
                    </button>
                  </div>
                </div>
                <div className="sample-layout">
                  <div className="sample-menu">
                    {samples
                      .filter((s) => s.language === language)
                      .map((s) => (
                        <button
                          key={s.id}
                          disabled={!!active}
                          className={sampleId === s.id ? "sample-active" : ""}
                          onClick={() => {
                            setSampleId(s.id);
                            setText(s.text);
                          }}
                        >
                          <span>{s.category}</span>
                          <small>{s.long ? "约 5 分钟" : s.title}</small>
                          {sampleId === s.id && <Icon name="arrow" />}
                        </button>
                      ))}
                  </div>
                  <div className="editor">
                    <div className="editor-title">
                      <span>
                        {sampleId === "custom"
                          ? "你的测试文本"
                          : currentSample?.title}
                      </span>
                      <small>
                        {currentSample?.long && sampleId !== "custom"
                          ? "预计时长仅供参考"
                          : ""}
                      </small>
                    </div>
                    <textarea
                      aria-label="试听原文"
                      spellCheck={false}
                      value={text}
                      disabled={!!active}
                      maxLength={12000}
                      onChange={(e) => {
                        setSampleId("custom");
                        setText(e.target.value);
                      }}
                    />
                    <div className="editor-footer">
                      <span>可直接编辑，或粘贴自己的文字</span>
                      <span>{text.length.toLocaleString()} / 12,000 字符</span>
                    </div>
                  </div>
                </div>
              </section>
              <div className="compare-heading">
                <div>
                  <h2>
                    <span>02</span>比较声音
                  </h2>
                  <p>依次生成 · 相同原文 · 统一试听音量</p>
                </div>
                <div className="compare-actions">
                  {active ? (
                    <button className="primary-button" onClick={stop}>
                      <Icon name="stop" />
                      停止生成
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={
                        boot ||
                        !selected.length ||
                        !text.trim() ||
                        text.length > 12000
                      }
                      onClick={() => start(selected)}
                    >
                      <Icon name="play" />
                      生成所选声音<span>{selected.length}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className={`candidate-grid count-${visible.length}`}>
                {visible.map(card)}
              </div>
              <div className="method-note">
                <Icon name="wave" />
                <div>
                  <strong>听感比参数更重要</strong>
                  <p>
                    先听自然度，再对照原文检查发音、漏读和停顿。试听按片段统一有效声音
                    RMS（目标 −20
                    dBFS，峰值受限），保留各模型原始采样率；不等同于广播 LUFS
                    标准。下载音频与试听一致。
                  </p>
                </div>
              </div>
            </>
          ) : (
            <section className="history-panel">
              {!runs.length ? (
                <div className="history-empty">
                  <Icon name="history" />
                  <h2>还没有试听记录</h2>
                  <p>生成第一段声音后，原文、音频和审核笔记会出现在这里。</p>
                  <button
                    className="primary-button"
                    onClick={() => setView("lab")}
                  >
                    开始试听
                    <Icon name="arrow" />
                  </button>
                </div>
              ) : (
                runs.map((run) => (
                  <article className="history-item" key={run.id}>
                    <div className="history-title">
                      <div>
                        <span className="chip">
                          {run.language === "zh" ? "中文" : "English"}
                        </span>
                        <h3>
                          {getCandidate(run.engineId).name} · {run.voiceId}
                        </h3>
                        <p>
                          {run.sampleName} ·{" "}
                          {new Date(run.createdAt).toLocaleString()} ·{" "}
                          {
                            (
                              {
                                done: "生成完成",
                                running: "生成中",
                                error: "生成失败",
                                cancelled: "已停止",
                              } as const
                            )[run.status]
                          }
                        </p>
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`删除 ${run.voiceId} 记录`}
                        disabled={!!active}
                        onClick={async () => {
                          try {
                            await removeRun(run.id);
                            runsRef.current = runsRef.current.filter(
                              (r) => r.id !== run.id,
                            );
                            setRuns(runsRef.current);
                          } catch {
                            setStorageError("删除失败，请重试。");
                          }
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                    {rejectedMandarinVoices.has(run.voiceId) && (
                      <p className="error">
                        该声音已因方言口音被移出普通话候选。此处仅保留原始试听记录。
                      </p>
                    )}
                    <details>
                      <summary>查看本次原文</summary>
                      <p className="source-text">{run.text}</p>
                    </details>
                    {run.chunks.length > 0 && <Player run={run} />}
                    <MetricsView run={run} />
                    {run.error && <p className="error">{run.error}</p>}
                    {run.chunks.length > 0 && (
                      <ReviewForm
                        run={run}
                        onChange={(review) => updateRun(run.id, { review })}
                      />
                    )}
                  </article>
                ))
              )}
            </section>
          )}
          <footer>
            <span>听见 · 试听评测版</span>
            <span>
              本地生成，不调用云端语音服务 <span className="footer-dot">·</span>{" "}
              <a href="/THIRD_PARTY.txt" target="_blank" rel="noreferrer">
                开源与来源
              </a>
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
