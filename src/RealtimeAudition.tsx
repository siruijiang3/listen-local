import { useEffect, useRef, useState } from "react";
import { samples } from "./samples";
import {
  AudioArchive,
  BrowserEngine,
  LocalEngine,
  segments,
  type Engine,
  type EngineEvent,
  type Mode,
  type RequestSpec,
} from "./realtime-core";
import "./realtime.css";
import { RealtimeComparisons } from "./RealtimeComparisons";
import { SavedMeasurements } from "./SavedMeasurements";

type Measurement = Record<string, unknown> & {
  runId: string;
  started: number;
  received: number;
  played: number;
  buffer: number;
  stalls: number;
  sequence: number;
  maxGap: number;
  lastChunk: number;
};
const sec = (n: unknown) => (typeof n === "number" ? n.toFixed(2) + " s" : "—");
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export default function RealtimeAudition() {
  const [mode, setMode] = useState<Mode>("local");
  const [language, setLanguage] = useState<"Chinese" | "English">("Chinese");
  const [speaker, setSpeaker] = useState("Serena");
  const [frames, setFrames] = useState(8);
  const [text, setText] = useState(samples[0].text);
  const [sampleId, setSampleId] = useState(samples[0].id);
  const [phase, setPhase] = useState("尚未准备");
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<Partial<Measurement>>({});
  const [model, setModel] = useState<Record<string, unknown>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [batch, setBatch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [savedAudio, setSavedAudio] = useState<
    Array<{ id: string; label: string; store: AudioArchive }>
  >([]);
  const [selectedAudio, setSelectedAudio] = useState("");
  const engine = useRef<Engine | undefined>(undefined);
  const context = useRef<AudioContext | undefined>(undefined);
  const player = useRef<AudioWorkletNode | undefined>(undefined);
  const measurement = useRef<Measurement | undefined>(undefined);
  const archive = useRef<AudioArchive | undefined>(undefined);
  const chain = useRef(Promise.resolve());
  const completed = useRef<Record<string, unknown>[]>([]);
  const batchStop = useRef(false);
  const done = useRef<((event: EngineEvent) => void) | undefined>(undefined);
  const runId = useRef("");
  const readyRef = useRef(false);
  const engineEpoch = useRef(0);
  const announce = (message: string) =>
    setEvents((old) =>
      [new Date().toLocaleTimeString() + " · " + message, ...old].slice(0, 30),
    );
  const refresh = () => {
    if (measurement.current) setSnapshot({ ...measurement.current });
  };

  const halt = () => {
    engine.current?.cancel();
    runId.current = "";
    player.current?.port.postMessage({ type: "reset", runId: "" });
    setActive(false);
    setPaused(false);
    done.current?.({ type: "cancelled" });
    done.current = undefined;
  };
  const fail = (message: string) => {
    setPreparing(false);
    batchStop.current = true;
    setReady(false);
    readyRef.current = false;
    setError(message);
    setPhase("已停止 / 需处理");
    announce(message);
    halt();
  };

  async function handle(e: EngineEvent) {
    if (e.runId && e.runId !== runId.current) return;
    if (e.type === "error") {
      fail(String(e.message));
      return;
    }
    if (e.type === "diagnostic") {
      setModel((old) => ({
        ...old,
        diagnostics: [
          ...((old.diagnostics as string[]) ?? []),
          String(e.message),
        ].slice(-200),
      }));
      announce(String(e.message));
      return;
    }
    if (e.type === "hello") {
      setModel((old) => ({ ...old, ...e }));
      return;
    }
    if (e.type === "status") {
      setPhase(String(e.message ?? e.phase));
      return;
    }
    if (e.type === "progress") {
      setModel((old) => ({ ...old, ...e }));
      return;
    }
    if (e.type === "ready") {
      setPreparing(false);
      setModel((old) => ({ ...old, ...e }));
      setReady(true);
      readyRef.current = true;
      setPhase("准备完成");
      announce("模型准备完成");
      return;
    }
    const m = measurement.current;
    if (!m || e.runId !== m.runId) return;
    if (e.type === "audio" && e.pcm) {
      if (e.sampleRate !== 24000 || !e.pcm.every(Number.isFinite))
        throw Error("PCM 格式或数值无效");
      if (e.seq !== m.sequence)
        throw Error(`音频序号不连续：期望 ${m.sequence}，收到 ${e.seq}`);
      const now = performance.now();
      m.sequence++;
      if (m.lastChunk)
        m.maxGap = Math.max(m.maxGap, (now - m.lastChunk) / 1000);
      m.lastChunk = now;
      m.received += e.pcm.length / 24000;
      if (m.firstBlockSeconds === undefined)
        m.firstBlockSeconds = (now - m.started) / 1000;
      if (m.firstPlayableSeconds === undefined && m.received >= 0.5)
        m.firstPlayableSeconds = (now - m.started) / 1000;
      for (const key of [
        "rssBytes",
        "gpuAllocatedBytes",
        "gpuReservedBytes",
        "gpuPeakBytes",
        "generationSeconds",
        "backpressureSeconds",
        "rtf",
        "stages",
      ])
        if (e[key] !== undefined) m[key] = e[key];
      const pcm = e.pcm;
      const store = archive.current;
      if (!store) throw Error("当前任务的音频存储不可用");
      // Worklet gets its own transferable copy; archive writes finish in order.
      const playback = pcm.slice();
      player.current?.port.postMessage(
        { type: "pcm", runId: m.runId, pcm: playback },
        [playback.buffer],
      );
      await store.append(pcm);
      m.storedSeconds = store.samples / 24000;
      // A mode change may release the engine while this disk write is pending.
      // Finish writing to the old archive without touching the new session UI.
      if (runId.current !== m.runId) return;
      setPhase("音频生成中");
      refresh();
    }
    if (e.type === "done" || e.type === "cancelled") {
      Object.assign(m, {
        generationSeconds: e.generationSeconds,
        rtf: e.rtf,
        backpressureSeconds: e.backpressureSeconds,
        wallSeconds: e.wallSeconds,
        gpuPeakBytes: e.gpuPeakBytes,
        completion: e.type,
      });
      if (m.firstPlayableSeconds === undefined && m.received)
        m.firstPlayableSeconds = (performance.now() - m.started) / 1000;
      player.current?.port.postMessage({ type: "end", runId: m.runId });
      setPhase(e.type === "done" ? "生成完成 · 播放剩余缓冲" : "已取消");
      completed.current.push({ ...m });
      await archive.current?.metadata(m);
      refresh();
      done.current?.(e);
      done.current = undefined;
    }
  }

  async function prepare() {
    setPreparing(true);
    setError("");
    setModel({});
    setReady(false);
    readyRef.current = false;
    setPhase("连接运行环境");
    try {
      halt();
      const epoch = ++engineEpoch.current;
      await engine.current?.release();
      const emit = (event: EngineEvent) => {
        chain.current = chain.current
          .then(() => {
            if (epoch === engineEpoch.current) return handle(event);
          })
          .catch((e) => fail(String(e)));
      };
      engine.current =
        mode === "local" ? new LocalEngine(emit) : new BrowserEngine(emit);
      await engine.current.prepare();
    } catch (e) {
      fail(String(e));
    }
  }

  async function audio() {
    if (context.current && context.current.state !== "closed") {
      await context.current.resume();
      return;
    }
    const ctx = (context.current = new AudioContext({
      sampleRate: 24000,
      latencyHint: "interactive",
    }));
    await ctx.audioWorklet.addModule("/realtime-player.js");
    const node = (player.current = new AudioWorkletNode(
      ctx,
      "qwen-realtime-player",
      { outputChannelCount: [1] },
    ));
    node.connect(ctx.destination);
    node.port.onmessage = ({ data: e }) => {
      const m = measurement.current;
      if (!m || !runId.current || e.runId !== runId.current) return;
      if (e.type === "progress") {
        m.played = e.playedSeconds;
        m.buffer = e.bufferSeconds;
        m.stalls = e.stalls;
        const tick = Math.floor((performance.now() - m.started) / 1000);
        if (m.traceTick !== tick) {
          m.traceTick = tick;
          const trace = (m.trace ??= []) as unknown[];
          trace.push({
            seconds: tick,
            played: m.played,
            buffer: m.buffer,
            stalls: m.stalls,
            rssBytes: m.rssBytes,
            gpuAllocatedBytes: m.gpuAllocatedBytes,
            gpuReservedBytes: m.gpuReservedBytes,
            jsMainThreadHeapBytes:
              (
                performance as unknown as {
                  memory?: { usedJSHeapSize: number };
                }
              ).memory?.usedJSHeapSize ?? null,
          });
          if (trace.length > 3600) trace.shift();
        }
        refresh();
      }
      if (e.type === "first") {
        // Browser output clock estimate, NOT an acoustic loopback measurement.
        const stamp = ctx.getOutputTimestamp();
        const output =
          stamp.performanceTime && stamp.contextTime
            ? stamp.performanceTime + (e.audioTime - stamp.contextTime) * 1000
            : performance.now() + (ctx.outputLatency || ctx.baseLatency) * 1000;
        m.firstOutputSeconds = Math.max(0, (output - m.started) / 1000);
        m.startToOutputSeconds = Math.max(
          0,
          (output - Number(m.interactionStarted ?? m.started)) / 1000,
        );
        m.firstOutputMethod =
          "AudioWorklet first nonzero sample + AudioContext output timestamp (estimate)";
        refresh();
      }
      if (e.type === "overflow") fail("播放缓冲超过固定容量，已停止，避免丢音");
      if (e.type === "finished") {
        m.playbackFinished = true;
        const saved = completed.current.findIndex((r) => r.runId === m.runId);
        if (saved >= 0) completed.current[saved] = { ...m };
        setActive(false);
        setPhase("播放完成");
        refresh();
        void archive.current?.metadata(m);
      }
    };
    ctx.onstatechange = () => {
      if (ctx.state === "suspended" && runId.current)
        announce("音频设备暂停；生成会在缓冲上限处等待");
    };
    await ctx.resume();
  }

  async function start(
    options?: Partial<{
      text: string;
      speaker: string;
      language: "Chinese" | "English";
      frames: number;
    }>,
  ) {
    const interactionStarted = performance.now();
    if (!readyRef.current) throw Error("请先准备模型");
    halt();
    await chain.current;
    await audio();
    const values = { text, speaker, language, frames, ...options };
    const parts = segments(values.text, values.language);
    if (!parts.length) throw Error("请输入文字");
    const id = crypto.randomUUID();
    const store = new AudioArchive();
    await store.open(id);
    archive.current = store;
    setSavedAudio((old) => [
      ...old,
      {
        id,
        label: `${values.speaker} · ${values.frames} 帧 · ${new Date().toLocaleTimeString()}`,
        store,
      },
    ]);
    setSelectedAudio(id);
    runId.current = id;
    const request: RequestSpec = {
      runId: id,
      speaker: values.speaker,
      language: values.language,
      frames: values.frames,
      segments: parts,
    };
    measurement.current = {
      runId: id,
      started: performance.now(),
      interactionStarted,
      setupSeconds: (performance.now() - interactionStarted) / 1000,
      received: 0,
      played: 0,
      buffer: 0,
      stalls: 0,
      sequence: 0,
      maxGap: 0,
      lastChunk: 0,
      engine: mode,
      request,
      model,
      createdAt: new Date().toISOString(),
      device: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      initialBufferSeconds: 0.5,
      maxBufferSeconds: 30,
      browserVramBytes: null,
      quality: "待人工审核",
    };
    player.current!.port.postMessage({ type: "reset", runId: id });
    setError("");
    setActive(true);
    setPaused(false);
    setPhase("生成首段音频");
    refresh();
    engine.current!.start(request);
  }
  async function switchMode(next: Mode) {
    batchStop.current = true;
    halt();
    engineEpoch.current++;
    await engine.current?.release();
    engine.current = undefined;
    await context.current?.close();
    context.current = undefined;
    player.current = undefined;
    measurement.current = undefined;
    archive.current = undefined;
    setSnapshot({});
    setMode(next);
    setPreparing(false);
    setReady(false);
    readyRef.current = false;
    setModel({});
    setPhase("尚未准备");
    setError("");
  }
  async function benchmark(kind: "short" | "frames" | "soak" | "long") {
    batchStop.current = false;
    setError("");
    try {
      await audio();
      const cases =
        kind === "short"
          ? ["Serena", "Uncle_Fu", "Aiden"].flatMap((voice) =>
              Array.from({ length: 20 }, (_, i) => ({
                voice,
                index: i,
                frames,
              })),
            )
          : kind === "frames"
            ? [4, 8, 12].flatMap((f) =>
                ["Serena", "Uncle_Fu", "Aiden"].map((voice) => ({
                  voice,
                  index: 0,
                  frames: f,
                })),
              )
            : (kind === "long" ? ["Uncle_Fu", "Aiden"] : ["Serena"]).map(
                (voice) => ({ voice, index: 0, frames }),
              );
      for (let i = 0; i < cases.length && !batchStop.current; i++) {
        const c = cases[i];
        const lang = c.voice === "Aiden" ? "English" : "Chinese";
        const available = samples.filter(
          (s) =>
            s.language === (lang === "Chinese" ? "zh" : "en") &&
            Boolean(s.long) === (kind === "soak" || kind === "long"),
        );
        const selected = available[c.index % available.length];
        // 12 repetitions comfortably exceed 30 minutes; stop only after 1800
        // seconds have actually left the worklet, not after rapid generation.
        const input =
          kind === "soak"
            ? Array(12).fill(selected.text).join("\n\n")
            : selected.text;
        setBatch(
          `${kind} · ${i + 1}/${cases.length} · ${c.voice} · ${c.frames} 帧`,
        );
        setSpeaker(c.voice);
        setLanguage(lang);
        setFrames(c.frames);
        setSampleId(selected.id);
        setText(selected.text);
        await start({
          text: input,
          speaker: c.voice,
          language: lang,
          frames: c.frames,
        });
        if (kind === "soak" || kind === "long") {
          while (
            !batchStop.current &&
            runId.current &&
            measurement.current?.completion !== "done" &&
            (kind !== "soak" || (measurement.current?.played ?? 0) < 1800)
          )
            await new Promise((r) => setTimeout(r, 500));
          if (kind === "long")
            while (
              !batchStop.current &&
              runId.current &&
              !measurement.current?.playbackFinished
            )
              await new Promise((r) => setTimeout(r, 500));
          if (kind === "soak") {
            if (measurement.current) {
              measurement.current.soakSeconds = measurement.current.played;
              completed.current.push({ ...measurement.current });
              await archive.current?.metadata(measurement.current);
            }
            halt();
          }
        } else
          await new Promise<void>((resolve) => {
            done.current = () => resolve();
          });
      }
    } catch (e) {
      fail(String(e));
    }
    setBatch("");
  }
  useEffect(() => {
    void fetch("/realtime-results.json")
      .then((r) => (r.ok ? r.json() : {}))
      .then(setResults)
      .catch(() => {});
    const timer = setInterval(() => {
      const m = measurement.current;
      if (m && runId.current === m.runId)
        engine.current?.flow(
          m.runId,
          Math.min(m.played, Number(m.storedSeconds ?? 0)),
        );
    }, 200);
    return () => {
      clearInterval(timer);
      batchStop.current = true;
      engine.current?.cancel();
      void engine.current?.release();
      void context.current?.close();
    };
  }, []);
  const attempt = (fn: () => Promise<unknown>) =>
    void fn().catch((e) => fail(String(e)));

  return (
    <main className="realtime">
      <nav>
        <a href="/">← 原版试听对照</a>
        <span>LOCAL AUDIO LAB / 02</span>
      </nav>
      <header>
        <p className="eyebrow">QWEN3-TTS · 0.6B CUSTOMVOICE</p>
        <h1>
          文字变成声音，
          <br />
          从第一句开始听。
        </h1>
        <p>电脑端实时实验 · 普通话 Serena / Uncle Fu · English Aiden</p>
      </header>
      <div className="rt-grid">
        <section className="rt-panel">
          <div className="rt-modes">
            <button
              className={mode === "local" ? "selected" : ""}
              disabled={!!batch}
              onClick={() => attempt(() => switchMode("local"))}
            >
              01 本地加速
            </button>
            <button
              className={mode === "browser" ? "selected" : ""}
              disabled={!!batch}
              onClick={() => attempt(() => switchMode("browser"))}
            >
              02 纯浏览器 WebGPU
            </button>
          </div>
          <p className="rt-hint">
            {mode === "local"
              ? "电脑上的 Qwen 生成，网页连续播放。仅连接本机回环服务。"
              : "WebGPU 实验在独立 Worker 内运行；不调用本地推理服务。"}
          </p>
          {results[mode] && (
            <p className="rt-status">本机验收：{results[mode]}</p>
          )}
          <div className="rt-fields">
            <label>
              语言
              <select
                value={language}
                disabled={!!batch}
                onChange={(e) => {
                  halt();
                  const l = e.target.value as typeof language;
                  setLanguage(l);
                  setSpeaker(l === "Chinese" ? "Serena" : "Aiden");
                }}
              >
                <option value="Chinese">中文 · 普通话</option>
                <option value="English">English</option>
              </select>
            </label>
            <label>
              声音
              <select
                value={speaker}
                disabled={!!batch}
                onChange={(e) => {
                  halt();
                  setSpeaker(e.target.value);
                }}
              >
                {(language === "Chinese"
                  ? ["Serena", "Uncle_Fu"]
                  : ["Aiden"]
                ).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              输出块
              <select
                value={frames}
                disabled={active || !!batch}
                onChange={(e) => setFrames(Number(e.target.value))}
              >
                {[4, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} 帧
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            测试原文
            <select
              value={sampleId}
              disabled={!!batch}
              onChange={(e) => {
                const s = samples.find((s) => s.id === e.target.value)!;
                halt();
                setSampleId(s.id);
                setText(s.text);
                setLanguage(s.language === "zh" ? "Chinese" : "English");
                setSpeaker(s.language === "zh" ? "Serena" : "Aiden");
              }}
            >
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.language.toUpperCase()} · {s.category} · {s.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            朗读内容
            <textarea
              value={text}
              disabled={!!batch}
              onChange={(e) => setText(e.target.value)}
              rows={10}
            />
          </label>
          <div className="rt-actions">
            <button
              onClick={() => attempt(prepare)}
              disabled={active || !!batch || preparing}
            >
              准备模型
            </button>
            <button
              className="primary"
              onClick={() => attempt(() => start())}
              disabled={!ready || !!batch}
            >
              开始 / 重新开始
            </button>
            <button
              disabled={!active}
              onClick={() => {
                player.current?.port.postMessage({
                  type: "pause",
                  runId: runId.current,
                  value: !paused,
                });
                setPaused(!paused);
              }}
            >
              {paused ? "继续播放" : "暂停播放"}
            </button>
            <button
              disabled={!active && !batch && !preparing}
              onClick={() => {
                batchStop.current = true;
                if (preparing) {
                  void attempt(async () => {
                    await switchMode(mode);
                    setPhase("准备已取消");
                  });
                  return;
                }
                halt();
                setPhase("已停止，已完成音频可导出");
              }}
            >
              停止
            </button>
          </div>
          {savedAudio.length > 0 && (
            <div className="rt-fields">
              <label>
                本页已生成音频
                <select
                  value={selectedAudio}
                  onChange={(e) => setSelectedAudio(e.target.value)}
                >
                  {savedAudio.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={exporting}
                onClick={() =>
                  attempt(async () => {
                    const saved = savedAudio.find(
                      (s) => s.id === selectedAudio,
                    );
                    if (!saved?.store.samples)
                      throw Error("所选任务尚未生成音频");
                    setExporting(true);
                    try {
                      await chain.current;
                      download(await saved.store.wav(), `qwen-${saved.id}.wav`);
                    } finally {
                      setExporting(false);
                    }
                  })
                }
              >
                下载所选 WAV
              </button>
            </div>
          )}
          <p role="status" className="rt-status">
            {paused ? "播放已暂停 · 保留位置 · 最多提前生成约 30 秒" : phase}
          </p>
          {error && (
            <p role="alert" className="rt-error">
              {error}
            </p>
          )}
        </section>
        <aside className="rt-panel rt-readout">
          <p className="eyebrow">LIVE MEASUREMENTS</p>
          <h2>生成与播放</h2>
          <div className="rt-big">
            {sec(snapshot.buffer)}
            <small>待播放缓冲 / 上限约 30 s</small>
          </div>
          <meter min={0} max={30} value={snapshot.buffer ?? 0} />
          <dl>
            <dt>首个音频块</dt>
            <dd>{sec(snapshot.firstBlockSeconds)}</dd>
            <dt>首个可播放缓冲</dt>
            <dd>{sec(snapshot.firstPlayableSeconds)}</dd>
            <dt>请求至首次输出¹</dt>
            <dd>{sec(snapshot.firstOutputSeconds)}</dd>
            <dt>启动至首次输出¹</dt>
            <dd>{sec(snapshot.startToOutputSeconds)}</dd>
            <dt>已生成 / 已播放</dt>
            <dd>
              {sec(snapshot.received)} / {sec(snapshot.played)}
            </dd>
            <dt>生成耗时 / 音频时长</dt>
            <dd>
              {typeof snapshot.rtf === "number" ? snapshot.rtf.toFixed(3) : "—"}
            </dd>
            <dt>缓冲不足次数</dt>
            <dd>{snapshot.stalls ?? 0}</dd>
            <dt>最大供给间隙²</dt>
            <dd>{sec(snapshot.maxGap)}</dd>
            <dt>模型加载 / 预热</dt>
            <dd>
              {sec(model.loadSeconds)} / {sec(model.warmupSeconds)}
            </dd>
            <dt>浏览器显存</dt>
            <dd>不可用</dd>
            <dt>本地 Torch 分配</dt>
            <dd>
              {typeof snapshot.gpuAllocatedBytes === "number"
                ? (snapshot.gpuAllocatedBytes / 2 ** 30).toFixed(2) + " GiB"
                : "—"}
            </dd>
          </dl>
          <p className="rt-hint">
            ¹ 浏览器输出时钟估计，未做扬声器回录测量。
            <br />² 包含主动背压等待。听感、漏读和接缝仍需人工审核。
          </p>
          <div className="rt-actions">
            <button
              disabled={!snapshot.received || exporting}
              onClick={() =>
                attempt(async () => {
                  setExporting(true);
                  try {
                    await chain.current;
                    download(await archive.current!.wav(), "qwen-realtime.wav");
                  } finally {
                    setExporting(false);
                  }
                })
              }
            >
              {exporting ? "导出中…" : "下载已完成 WAV"}
            </button>
            <button
              onClick={() =>
                download(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          model,
                          current: measurement.current,
                          runs: completed.current,
                          events,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                  "qwen-realtime-measurements.json",
                )
              }
            >
              导出测量记录
            </button>
          </div>
          <p className="rt-hint">
            PCM 分块写入 OPFS；导出不计入首声等待。{String(model.device ?? "")}
          </p>
          {mode === "browser" && (
            <p className="rt-hint">
              本次下载：
              {typeof model.downloadBytes === "number"
                ? (model.downloadBytes / 2 ** 20).toFixed(1)
                : "—"}{" "}
              MiB · 资源清单：{" "}
              {typeof model.modelBytes === "number"
                ? (model.modelBytes / 2 ** 20).toFixed(1)
                : "—"}{" "}
              MiB · {model.cached ? "当前资源命中缓存" : "读取资源"}
              <br />
              音频解码校验：
              {typeof model.decoderMaxError === "number"
                ? `最大误差 ${model.decoderMaxError.toExponential(2)}`
                : "尚未完成"}
            </p>
          )}
        </aside>
      </div>
      <section className="rt-panel rt-tests">
        <h2>验收实验</h2>
        <p>
          测试会实际合成与播放；运行时请保持页面和音频设备可用。每次记录独立任务编号、原文与配置。
        </p>
        <div className="rt-actions">
          <button
            disabled={!ready || active || !!batch}
            onClick={() => attempt(() => benchmark("frames"))}
          >
            比较 4 / 8 / 12 帧
          </button>
          <button
            disabled={!ready || active || !!batch}
            onClick={() => attempt(() => benchmark("short"))}
          >
            三种声音各 20 次
          </button>
          <button
            disabled={!ready || active || !!batch}
            onClick={() => attempt(() => benchmark("soak"))}
          >
            女声连续播放 30 分钟
          </button>
          <button
            disabled={!ready || active || !!batch}
            onClick={() => attempt(() => benchmark("long"))}
          >
            男声及英文长文
          </button>
          {mode === "browser" && (
            <button
              disabled={!ready || !!batch}
              onClick={() => {
                if (engine.current instanceof BrowserEngine) {
                  announce("模拟本页 WebGPU 设备丢失，不重置物理显卡");
                  engine.current.simulateDeviceLoss();
                }
              }}
            >
              验证 GPU 丢失处理
            </button>
          )}
          <button
            disabled={active || !!batch}
            onClick={() =>
              attempt(async () => {
                await switchMode(mode);
                const root = await navigator.storage.getDirectory();
                await root
                  .removeEntry("qwen-realtime-v1", { recursive: true })
                  .catch((e) => {
                    if (e.name !== "NotFoundError") throw e;
                  });
                setSavedAudio([]);
                archive.current = undefined;
                setSnapshot({});
                announce("已清理本页 OPFS 音频");
              })
            }
          >
            释放模型 / 清理音频
          </button>
        </div>
        <p>{batch || "尚未据此宣布实时达标"}</p>
        <details>
          <summary>运行日志</summary>
          <pre>{events.join("\n")}</pre>
        </details>
      </section>
      <RealtimeComparisons />
      <SavedMeasurements />
    </main>
  );
}
