import { useEffect, useState } from "react";
import { samples } from "./samples";
import "./qwen-audition.css";

interface Clip {
  id: string;
  fingerprint: string;
  file: string;
  sampleId: string;
  text: string;
  speaker: string;
  seconds: number;
  generationSeconds: number;
  peakGpuBytes: number;
  cpuThreads?: number;
  sampleRate: number;
  sha256: string;
  createdAt: string;
  parts: { text: string; seconds: number; generationSeconds: number }[];
}
interface Manifest {
  model: string;
  revision: string;
  packageVersion: string;
  device: string;
  torchVersion: string;
  modelBytes: number;
  downloadSeconds: number;
  loadSeconds: number;
  clips: Clip[];
}
interface Note {
  verdict: string;
  issues: string[];
  text: string;
}
const storageKey = "listen-qwen-audition-reviews-v1";
const modelSizes = ["0.6B", "1.7B"] as const;
type ModelSize = (typeof modelSizes)[number];
const assetRoots: Record<ModelSize, string> = {
  "0.6B": "/auditions/qwen3-0.6b",
  "1.7B": "/auditions/qwen3",
};
const options = [
  "地方口音",
  "听不清",
  "错读",
  "漏读或重复",
  "断句异常",
  "不自然",
];
const voices = { zh: ["Serena", "Uncle_Fu"], en: ["Aiden"] };
const labels: Record<string, string> = {
  Serena: "Serena · 女声",
  Uncle_Fu: "Uncle Fu · 男声",
  Aiden: "Aiden · 男声",
};
function timecode(seconds: number) {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
function saveDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function QwenAudition() {
  const [modelSize, setModelSize] = useState<ModelSize>(
    new URLSearchParams(window.location.search).get("model") === "1.7B"
      ? "1.7B"
      : "0.6B",
  );
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [sampleId, setSampleId] = useState("zh-story");
  const [manifests, setManifests] = useState<
    Partial<Record<ModelSize, Manifest>>
  >({});
  const [loadErrors, setLoadErrors] = useState<
    Partial<Record<ModelSize, string>>
  >({});
  const manifest = manifests[modelSize];
  const assetRoot = assetRoots[modelSize];
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [notes, setNotes] = useState<Record<string, Note>>({});
  useEffect(() => {
    try {
      setNotes(JSON.parse(localStorage.getItem(storageKey) || "{}"));
    } catch {
      setStorageError("原有评价无法读取；新评价仍可导出保存。");
    }
  }, []);
  async function refresh() {
    const results = await Promise.all(
      modelSizes.map(async (size) => {
        try {
          const response = await fetch(
            `${assetRoots[size]}/manifest.json?refresh=${Date.now()}`,
            { cache: "no-store" },
          );
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("json")
          )
            throw new Error("本轮音频尚未就绪，请稍后刷新样音列表。");
          const data = await response.json();
          if (!Array.isArray(data.clips)) throw new Error("样音清单格式有误。");
          if (data.model !== `Qwen/Qwen3-TTS-12Hz-${size}-CustomVoice`)
            throw new Error("模型与样音清单不匹配。");
          return { size, data: data as Manifest, error: "" };
        } catch (e) {
          return {
            size,
            data: undefined,
            error: e instanceof Error ? e.message : "样音列表加载失败。",
          };
        }
      }),
    );
    setManifests(Object.fromEntries(results.map((r) => [r.size, r.data])));
    setLoadErrors(Object.fromEntries(results.map((r) => [r.size, r.error])));
    setError("");
  }
  useEffect(() => {
    void refresh();
  }, []);
  function update(key: string, patch: Partial<Note>) {
    const next = {
      ...notes,
      [key]: {
        ...(notes[key] ?? { verdict: "", issues: [], text: "" }),
        ...patch,
      },
    };
    setNotes(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError("");
    } catch {
      setStorageError("浏览器未能保存评价，请使用导出按钮保留记录。");
    }
  }
  const sample = samples.find((s) => s.id === sampleId)!;
  const changeLanguage = (lang: "zh" | "en") => {
    setLanguage(lang);
    setSampleId(`${lang}-story`);
  };
  return (
    <div className="qwen-page">
      <header className="qwen-header">
        <a href="/">
          听见 <span>LISTEN LOCAL</span>
        </a>
        <a href="/?realtime=1">实时试听 · Qwen 0.6B ↗</a>
        <a href="/?legacy=1">旧版 Kokoro / Piper 记录 ↗</a>
      </header>
      <main className="qwen-main">
        <div className="qwen-intro">
          <p className="qwen-kicker">轻量版试听 · 官方原版对比</p>
          <h1>小一点，还好听吗？</h1>
          <p>Qwen3-TTS 0.6B 与 1.7B · 相同原文、相同声音，直接比较。</p>
        </div>
        <div className="qwen-banner">
          <strong>本机预生成样音，支持播放与下载</strong>
          <p>
            使用官方 Python
            实现，在本机显卡生成；没有经过之前的浏览器中文发音转换。此页播放已生成的
            WAV，不在浏览器中运行 Qwen，也不提供任意文本实时合成。
          </p>
          <p>1.7B 已获你的本轮试听认可；0.6B 原版待审核。两者均未量化。</p>
          <p>
            内置浏览器在播放测试中出现崩溃。建议在独立 Chrome / Edge
            打开本页，或下载 WAV 用系统播放器审核。
          </p>
        </div>
        <div className="qwen-actions" aria-label="选择试听模型">
          <div className="qwen-languages">
            {modelSizes.map((size) => (
              <button
                key={size}
                aria-pressed={modelSize === size}
                onClick={() => {
                  setModelSize(size);
                  setError("");
                }}
              >
                {size} 原版{size === "1.7B" ? " · 对照" : " · 本轮"}
              </button>
            ))}
          </div>
          <small>切换模型保留当前原文；评价按具体音频分别保存。</small>
        </div>
        <div className="qwen-actions">
          <div className="qwen-languages">
            <button
              aria-pressed={language === "zh"}
              onClick={() => changeLanguage("zh")}
            >
              中文 · 普通话审核
            </button>
            <button
              aria-pressed={language === "en"}
              onClick={() => changeLanguage("en")}
            >
              English
            </button>
          </div>
          <button className="qwen-secondary" onClick={() => void refresh()}>
            刷新样音列表
          </button>
        </div>
        {(error || loadErrors[modelSize]) && (
          <p role="alert">{error || loadErrors[modelSize]}</p>
        )}
        {storageError && <p role="alert">{storageError}</p>}
        <section className="qwen-text-panel">
          <div className="qwen-section-heading">
            <h2>01 选择原文</h2>
            <span>沿用上一轮测试文字</span>
          </div>
          <div className="qwen-passages">
            {samples
              .filter((s) => s.language === language)
              .map((s) => (
                <button
                  key={s.id}
                  aria-pressed={s.id === sampleId}
                  onClick={() => setSampleId(s.id)}
                >
                  <small>{s.category}</small>
                  {s.long ? "连续长文" : s.title}
                </button>
              ))}
          </div>
          <h3>{sample.title}</h3>
          <p className="qwen-original">{sample.text}</p>
          <small>
            {sample.long
              ? "长文按原始段落生成后拼接，未插入额外静音；实际时长以播放器为准。"
              : "短文整段输入模型，不逐句截断。"}
          </small>
        </section>
        <div className="qwen-section-heading">
          <h2>02 听声音，记录判断</h2>
          <span>
            {modelSize} · {manifest?.clips.length ?? 0} / 18 条样音已生成
          </span>
        </div>
        <div className="qwen-voices">
          {voices[language].map((speaker) => {
            const clip = manifest?.clips.find(
              (c) => c.sampleId === sampleId && c.speaker === speaker,
            );
            const key = clip?.fingerprint || "";
            const note = notes[key] || { verdict: "", issues: [], text: "" };
            return (
              <article
                className="qwen-voice"
                key={`${modelSize}-${speaker}-${sampleId}`}
              >
                <div className="qwen-voice-heading">
                  <span className="qwen-avatar">
                    {speaker === "Serena"
                      ? "S"
                      : speaker === "Aiden"
                        ? "A"
                        : "F"}
                  </span>
                  <div>
                    <h3>{labels[speaker]}</h3>
                    <small>Qwen3-TTS · {modelSize} CustomVoice</small>
                  </div>
                  <span className="qwen-pending">
                    {note.verdict || "待审核"}
                  </span>
                </div>
                {clip ? (
                  <>
                    <audio
                      key={clip.fingerprint}
                      controls
                      preload="metadata"
                      aria-label={`${modelSize} ${speaker} ${sample.title} 试听`}
                      src={`${assetRoot}/${clip.file}`}
                      onPlay={(e) =>
                        document.querySelectorAll("audio").forEach((a) => {
                          if (a !== e.currentTarget) a.pause();
                        })
                      }
                      onError={() =>
                        setError(
                          "音频加载失败。请刷新样音列表，或下载 WAV 后使用系统播放器。",
                        )
                      }
                    />
                    <div className="qwen-audio-meta">
                      <span>
                        {clip.seconds.toFixed(1)} 秒 · {clip.sampleRate / 1000}{" "}
                        kHz WAV
                      </span>
                      <a href={`${assetRoot}/${clip.file}`} download>
                        下载 WAV ↓
                      </a>
                    </div>
                    <div
                      className="qwen-verdict"
                      aria-label={`${speaker} 审核结果`}
                    >
                      {["可以继续评测", "不接受"].map((v) => (
                        <button
                          key={v}
                          aria-pressed={note.verdict === v}
                          onClick={() =>
                            update(key, {
                              verdict: note.verdict === v ? "" : v,
                            })
                          }
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                    <div className="qwen-issues">
                      {options.map((issue) => (
                        <label key={issue}>
                          <input
                            type="checkbox"
                            checked={note.issues.includes(issue)}
                            onChange={(e) =>
                              update(key, {
                                issues: e.target.checked
                                  ? [...note.issues, issue]
                                  : note.issues.filter((i) => i !== issue),
                              })
                            }
                          />
                          {issue}
                        </label>
                      ))}
                    </div>
                    <textarea
                      aria-label={`${speaker} 试听笔记`}
                      placeholder="哪些字听不清？哪里不自然？可记录时间点。"
                      value={note.text}
                      onChange={(e) => update(key, { text: e.target.value })}
                    />
                    <details>
                      <summary>实际生成信息与原文分段</summary>
                      <p>
                        生成用时 {clip.generationSeconds.toFixed(1)} 秒 ·
                        生成／音频时长{" "}
                        {(clip.generationSeconds / clip.seconds).toFixed(2)}× ·
                        峰值已分配显存{" "}
                        {(clip.peakGpuBytes / 1024 ** 3).toFixed(2)}{" "}
                        GiB（PyTorch 指标）· CPU 线程 {clip.cpuThreads ?? 6}
                      </p>
                      <p>
                        原速、无风格指令、无音高处理；整条音频统一有效声音 RMS
                        目标为 −20 dBFS，并限制峰值；非 LUFS 标准。
                      </p>
                      <ol>
                        {clip.parts.map((part, i) => {
                          const start = clip.parts
                            .slice(0, i)
                            .reduce((sum, p) => sum + p.seconds, 0);
                          return (
                            <li key={i}>
                              <small>
                                {timecode(start)}–
                                {timecode(start + part.seconds)}
                              </small>{" "}
                              {part.text}
                            </li>
                          );
                        })}
                      </ol>
                      <small>SHA-256: {clip.sha256}</small>
                    </details>
                  </>
                ) : (
                  <div className="qwen-unavailable">
                    此声音的这段样音尚未生成。请先选择已有样音。
                  </div>
                )}
              </article>
            );
          })}
        </div>
        <div className="qwen-export">
          <p>
            评价只保存在这个浏览器。生成成功不代表读音、漏读或自然度已通过。
          </p>
          {manifest?.clips.length === 18 && (
            <a
              className="qwen-secondary"
              href={`${assetRoot}/qwen3-auditions.zip`}
              download={`qwen3-${modelSize}-auditions.zip`}
            >
              下载 {modelSize} 全部样音与原文 ZIP
            </a>
          )}
          <button
            className="qwen-secondary"
            onClick={() =>
              saveDownload(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        exportedAt: new Date().toISOString(),
                        model: manifest?.model,
                        revision: manifest?.revision,
                        clips: manifest?.clips.map(
                          ({ id, fingerprint, text, speaker, sha256 }) => ({
                            id,
                            fingerprint,
                            text,
                            speaker,
                            sha256,
                          }),
                        ),
                        reviews: Object.fromEntries(
                          Object.entries(notes).filter(([key]) =>
                            manifest?.clips.some((c) => c.fingerprint === key),
                          ),
                        ),
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                `qwen-${modelSize}-audition-reviews.json`,
              )
            }
          >
            导出本轮审核记录
          </button>
        </div>
        <details className="qwen-provenance">
          <summary>来源、运行设备与测试边界</summary>
          <p>
            {manifest?.model} · Apache-2.0
            <br />
            官方 qwen-tts {manifest?.packageVersion} · PyTorch{" "}
            {manifest?.torchVersion}
            <br />
            {manifest?.device} · BF16 / SDPA
            <br />
            固定权重版本：{manifest?.revision}
          </p>
          <p>
            模型文件共 {((manifest?.modelBytes || 0) / 1e9).toFixed(2)} GB；下载{" "}
            {((manifest?.downloadSeconds || 0) / 60).toFixed(1)} 分钟；本轮加载{" "}
            {(manifest?.loadSeconds || 0).toFixed(1)}{" "}
            秒。以上是生成机器的数据，播放页面无需下载模型。
          </p>
          <p>
            内置浏览器曾在播放时退出。若遇到此问题，可下载 WAV
            用系统播放器听，或在独立 Chrome / Edge
            打开同一地址。不同浏览器的审核记录不互通。
          </p>
          <a
            href="https://github.com/QwenLM/Qwen3-TTS"
            target="_blank"
            rel="noreferrer"
          >
            官方实现与声音说明 ↗
          </a>
          <p>本轮只审核中英文。法语、西语、俄语等能力尚未在此页验收。</p>
        </details>
        <footer className="qwen-footer">
          听见 · 让声音通过你的审核，再继续做电子书。
          <a href="/THIRD_PARTY.txt">开源与来源</a>
        </footer>
      </main>
    </div>
  );
}
