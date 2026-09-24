import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  connect,
  request,
  type Chapter,
  type State,
  type Job,
  type Settings,
} from "./api";
import { Player } from "./player";
import { Reader } from "./Reader";
import { SeekBar } from "./SeekBar";
import { useReaderIndex } from "./reading-index";

const labels: Record<string, string> = {
  queued: "等待生成",
  preparing: "准备模型",
  running: "正在生成",
  exporting: "封装成品",
  done: "已完成",
  paused: "已暂停",
  cancelled: "已取消",
  failed: "需要处理",
};
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const busy = (job: Job) =>
  ["queued", "preparing", "running", "exporting"].includes(job.status);

export default function App() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"library" | "tasks" | "reader">("library");
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<{ title: string; chapters: Chapter[] }>();
  const [chapter, setChapter] = useState(0);
  const [settings, setSettings] = useState<Settings>();
  const [speaker, setSpeaker] = useState("Serena");
  const [device, setDevice] = useState("auto");
  const [mode, setMode] = useState<"live" | "after">("live");
  const [playing, setPlaying] = useState("");
  const [paused, setPaused] = useState(false);
  const [position, setPosition] = useState(0);
  const positionRef = useRef(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [followToken, setFollowToken] = useState(0);
  const saveQueue = useRef(Promise.resolve());
  const [stalls, setStalls] = useState(0);
  const playingRef = useRef("");
  const savedAt = useRef(0);
  const positions = useRef<Record<string, number>>({});
  const autoPlay = useRef("");
  const player = useRef<Player | undefined>(undefined);
  const refresh = useCallback(async () => {
    const next = await request<State>("state");
    setState(next);
    return next;
  }, []);
  const fail = useCallback(
    (reason: unknown) =>
      setError(String(reason instanceof Error ? reason.message : reason)),
    [],
  );
  const savePosition = useCallback(
    (id: string, seconds: number) => {
      if (!id) return;
      positions.current[id] = seconds;
      const metrics = { ...player.current?.metrics };
      saveQueue.current = saveQueue.current
        .then(() => request("played", { id, seconds, metrics }))
        .then(() => {}, fail);
    },
    [fail],
  );
  const act = async <T,>(
    action: string,
    body: unknown,
  ): Promise<T | undefined> => {
    try {
      setError("");
      const result = await request<T>(action, body);
      await refresh();
      return result;
    } catch (reason) {
      fail(reason);
    }
  };
  useEffect(() => {
    let cancelled = false;
    void connect()
      .then(() => {
        if (!cancelled) return refresh();
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [refresh, fail]);
  useEffect(() => {
    const working = state?.jobs.some(busy) || state?.setup?.running;
    if (!working && !state?.engine) return;
    // An unloaded, idle app does not poll; a retained model needs only a slow refresh.
    const timer = setTimeout(
      () => void refresh().catch(fail),
      working ? 700 : 30000,
    );
    return () => clearTimeout(timer);
  }, [state, refresh, fail]);
  useEffect(() => {
    if (state?.setup && !state.setup.running && !state.setup.error) {
      setSettings((current) =>
        current
          ? {
              ...current,
              runtimePython: state.settings.runtimePython,
              model: state.settings.model,
            }
          : current,
      );
    }
  }, [
    state?.setup?.running,
    state?.settings.runtimePython,
    state?.settings.model,
  ]);
  useEffect(() => {
    player.current = new Player(
      (seconds, count, finished) => {
        positionRef.current = seconds;
        setPosition(seconds);
        setStalls(count);
        if (finished) setPaused(true);
        if (Date.now() - savedAt.current > 3000 || finished) {
          savedAt.current = Date.now();
          savePosition(playingRef.current, seconds);
        }
      },
      (reason) => {
        setPaused(true);
        fail(reason);
      },
    );
    return () => {
      void player.current?.close();
    };
  }, [fail, savePosition]);
  const start = async (
    job: Job,
    seconds = playingRef.current === job.id
      ? positionRef.current
      : (positions.current[job.id] ?? job.played ?? 0),
    keepPaused = false,
  ) => {
    try {
      savePosition(playingRef.current, positionRef.current);
      seconds = Math.max(0, Math.min(seconds, job.samples / 24000));
      playingRef.current = job.id;
      setPlaying(job.id);
      setTab("reader");
      setPreview(null);
      setFollowToken((token) => token + 1);
      positionRef.current = seconds;
      setPosition(seconds);
      setPaused(keepPaused);
      setStalls(0);
      player.current?.update(job.samples, job.completed === job.total);
      await player.current?.start(job.id, seconds, keepPaused);
      if (playingRef.current === job.id)
        savePosition(job.id, positionRef.current);
    } catch (reason) {
      fail(reason);
    }
  };
  useEffect(() => {
    const current = state?.jobs.find((j) => j.id === playing);
    if (current)
      player.current?.update(
        current.samples,
        current.completed === current.total,
      );
    const next = state?.jobs.find((j) => j.id === autoPlay.current);
    if (
      next &&
      next.samples > 0 &&
      (next.mode === "live" || next.status === "done")
    ) {
      autoPlay.current = "";
      void start(next, 0);
    }
  }, [state, playing]);

  const importFile = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "电子书", extensions: ["epub", "txt", "pdf"] }],
      });
      if (typeof path !== "string") return;
      const book = await act<{
        title: string;
        chapters: Chapter[];
        warnings?: string[];
      }>("import", { path });
      if (book) {
        setDraft(book);
        setChapter(0);
        if (book.warnings?.length) setNotice(book.warnings.join("\n"));
      }
    } catch (reason) {
      fail(reason);
    }
  };
  const editBook = async (id: string) => {
    const book = await act<{ title: string; chapters: Chapter[] }>("book", {
      id,
    });
    if (book) {
      setDraft(book);
      setChapter(0);
    }
  };
  const generate = async () => {
    const result = await act<{ id: string }>("generate", {
      book: selected,
      speaker,
      device,
      mode,
    });
    if (result) {
      autoPlay.current = result.id;
      setTab("tasks");
    }
  };
  const playingJob = state?.jobs.find((j) => j.id === playing);
  const readerIndex = useReaderIndex(playingJob, fail);
  const lastAvailable = useRef({ job: "", samples: 0 });
  useEffect(() => {
    if (playingJob) {
      if (
        (lastAvailable.current.job === playingJob.id &&
          playingJob.samples < lastAvailable.current.samples) ||
        positionRef.current > playingJob.samples / 24000
      ) {
        void start(
          playingJob,
          Math.min(positionRef.current, playingJob.samples / 24000),
          true,
        );
      }
      lastAvailable.current = {
        job: playingJob.id,
        samples: playingJob.samples,
      };
    }
  }, [playingJob?.id, playingJob?.samples]);
  const activeCount = state?.jobs.filter(busy).length || 0;
  const selectedBook = state?.books.find((b) => b.id === selected);
  const chooseSetting = async (
    field: "library" | "model" | "runtimePython",
  ) => {
    try {
      const path = await open({
        directory: field !== "runtimePython",
        multiple: false,
        ...(field === "runtimePython"
          ? { filters: [{ name: "Python", extensions: ["exe"] }] }
          : {}),
      });
      if (typeof path === "string" && settings)
        setSettings({ ...settings, [field]: path });
    } catch (reason) {
      fail(reason);
    }
  };
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">听</span>
          <div>
            <strong>听见</strong>
            <small>LISTEN LOCAL</small>
          </div>
        </div>
        <nav>
          <button
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            ▤　我的书库 <span>{state?.books.length || 0}</span>
          </button>
          <button
            className={tab === "tasks" ? "active" : ""}
            onClick={() => setTab("tasks")}
          >
            ≋　生成任务 <span>{activeCount}</span>
          </button>
        </nav>
        {playingJob && (
          <button
            className={tab === "reader" ? "active" : ""}
            onClick={() => setTab("reader")}
          >
            ▣　阅读与收听
          </button>
        )}
        <div className="rail-bottom">
          <span className="local-dot" /> 本地生成，安心收听
          <p>
            书籍与音频留在你的电脑。
            <br />
            关闭窗口后，任务仍在托盘继续。
          </p>
          <button onClick={() => state && setSettings({ ...state.settings })}>
            ⚙　设置与模型
          </button>
        </div>
      </aside>
      <main className={tab === "reader" ? "reading-main" : ""}>
        <header hidden={tab === "reader"}>
          <div>
            <p className="eyebrow">让阅读，有另一种方式</p>
            <h1>
              {tab === "library"
                ? "把好书，留给耳朵。"
                : tab === "reader"
                  ? "边听，边读。"
                  : "声音正在成形。"}
            </h1>
            <p className="muted">
              {tab === "library"
                ? "导入一本书，在电脑上生成，带到任何地方听。"
                : tab === "reader"
                  ? "原文与音频，随时双向定位。"
                  : "生成与收听彼此独立。暂停播放，也不耽误后面的内容。"}
            </p>
          </div>
          <button className="primary" onClick={importFile}>
            ＋ 导入电子书
          </button>
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {notice && (
          <div className="banner">
            {notice}
            <button onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {!state && (
          <section className="empty">
            <h2>正在连接本地书库…</h2>
            <p>首次启动无需加载语音模型。</p>
            <button onClick={() => void connect().then(refresh).catch(fail)}>
              重新连接
            </button>
          </section>
        )}
        {state && !state.settings.runtimePython && (
          <div className="setup-card">
            <div>
              <strong>先准备一次，之后离线使用</strong>
              <p>下载适合电脑的原生运行包与语音模型，或选择已有文件。</p>
            </div>
            <button onClick={() => setSettings({ ...state.settings })}>
              准备模型 →
            </button>
          </div>
        )}
        {state?.setup && (
          <div className="banner">
            {state.setup.message}
            {state.setup.running && state.setup.total > 0 && (
              <progress value={state.setup.bytes} max={state.setup.total} />
            )}
          </div>
        )}
        {state && tab === "library" && (
          <div className="library-layout">
            <section>
              <div className="section-head">
                <h2>
                  我的书籍 <small>{state.books.length}</small>
                </h2>
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft({
                      title: "未命名书籍",
                      chapters: [{ title: "正文", text: "" }],
                    });
                    setChapter(0);
                  }}
                >
                  粘贴文字
                </button>
              </div>
              {state.books.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">▤</div>
                  <h2>从一本想听的书开始</h2>
                  <p>
                    支持 EPUB、TXT 和文字版 PDF。
                    <br />
                    导入后可以先检查章节和正文。
                  </p>
                  <button onClick={importFile}>选择电子书</button>
                </div>
              ) : (
                <div className="book-grid">
                  {state.books.map((book, index) => (
                    <button
                      key={book.id}
                      className={`book-card ${selected === book.id ? "selected" : ""}`}
                      onClick={() => setSelected(book.id)}
                    >
                      <div className={`cover color-${index % 4}`}>
                        <span>听见 · 私人书架</span>
                        <strong>{book.title}</strong>
                        <div className="cover-lines">
                          〰<br />〰
                        </div>
                        <small>LOCAL AUDIOBOOK</small>
                      </div>
                      <strong className="book-title">{book.title}</strong>
                      <small>
                        {new Date(book.created * 1000).toLocaleDateString(
                          "zh-CN",
                        )}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <aside className="make-panel">
              <p className="eyebrow">制作有声书</p>
              <h2>{selectedBook?.title || "选择一本书"}</h2>
              <p className="muted">完整保留正文，让熟悉的声音陪你读下去。</p>
              <label>
                朗读声音
                <select
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                >
                  <option value="Serena">Serena · 中文女声</option>
                  <option value="Uncle_Fu">Uncle Fu · 中文男声</option>
                  <option value="Aiden">Aiden · 英文男声</option>
                </select>
              </label>
              <label>
                计算设备
                <select
                  value={device}
                  onChange={(e) => {
                    setDevice(e.target.value);
                    if (e.target.value === "cpu") setMode("after");
                  }}
                >
                  <option value="auto">自动 · 优先 NVIDIA GPU</option>
                  <option value="gpu">NVIDIA GPU</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>
              <fieldset>
                <legend>收听方式</legend>
                <label className="radio">
                  <input
                    type="radio"
                    checked={mode === "live"}
                    onChange={() => setMode("live")}
                  />
                  边生成边听
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    checked={mode === "after"}
                    onChange={() => setMode("after")}
                  />
                  生成完成后播放
                </label>
              </fieldset>
              {device === "cpu" && (
                <p className="hint">
                  CPU 按自然段输出，可能慢于播放速度，建议生成后再听。
                </p>
              )}
              <button
                className="primary wide"
                disabled={!selected || !state.settings.runtimePython}
                onClick={generate}
              >
                开始生成
              </button>
              <button
                className="wide"
                disabled={!selected}
                onClick={() => void editBook(selected)}
              >
                查看正文 / 编辑为新版本
              </button>
              <p className="fine">
                Qwen3-TTS 0.6B · 原生本地推理
                <br />
                音频完成后可扫码传到手机。
              </p>
            </aside>
          </div>
        )}
        {state && tab === "tasks" && (
          <section className="tasks">
            {state.jobs.length === 0 && (
              <div className="empty">
                <h2>还没有生成任务</h2>
                <p>在书库中选择书籍和声音，即可开始。</p>
                <button onClick={() => setTab("library")}>回到书库</button>
              </div>
            )}
            {state.jobs.map((job) => (
              <article key={job.id} className="job">
                <div className="job-heading">
                  <div>
                    <span className={`badge ${job.status}`}>
                      {labels[job.status] || job.status}
                    </span>
                    <h2>{job.title}</h2>
                    <p>
                      {job.speaker} ·{" "}
                      {job.actual_device === "cuda"
                        ? "NVIDIA GPU"
                        : job.actual_device === "cpu"
                          ? "CPU"
                          : "等待分配设备"}{" "}
                      · 已生成 {time(job.samples / 24000)}
                    </p>
                  </div>
                  <strong>
                    {job.completed}
                    <small> / {job.total} 段</small>
                  </strong>
                </div>
                <progress value={job.completed} max={job.total} />
                {job.rtf != null && (
                  <p className="fine">
                    生成耗时 / 音频时长：{job.rtf.toFixed(3)}（小于 1
                    表示快于实时）
                  </p>
                )}
                {job.error && <p className="job-message">{job.error}</p>}
                <div className="actions">
                  {job.samples > 0 && (
                    <button onClick={() => void start(job)}>
                      ▶ {job.played ? "继续收听" : "收听"}
                    </button>
                  )}
                  {busy(job) && (
                    <>
                      <button onClick={() => void act("pause", { id: job.id })}>
                        暂停生成
                      </button>
                      <button
                        onClick={() => void act("cancel", { id: job.id })}
                      >
                        取消任务
                      </button>
                    </>
                  )}
                  {["paused", "cancelled", "failed"].includes(job.status) && (
                    <button onClick={() => void act("resume", { id: job.id })}>
                      恢复任务
                    </button>
                  )}
                  {job.status === "done" && (
                    <button
                      className="primary"
                      onClick={() => void act("share", { id: job.id })}
                    >
                      发送到手机
                    </button>
                  )}
                </div>
                {job.exports.length > 0 && (
                  <details>
                    <summary>导出成品 · M4B / MP3 / ZIP</summary>
                    <div className="exports">
                      {job.exports.map((file) => (
                        <button
                          key={file.id}
                          onClick={async () => {
                            try {
                              const directory = await open({ directory: true });
                              if (typeof directory === "string") {
                                const result = await act<{ path: string }>(
                                  "copy_export",
                                  { id: file.id, directory },
                                );
                                if (result) setNotice(`已保存：${result.path}`);
                              }
                            } catch (reason) {
                              fail(reason);
                            }
                          }}
                        >
                          {file.name}
                          <small>
                            {(file.bytes / 1048576).toFixed(1)} MB　↗
                          </small>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </article>
            ))}
          </section>
        )}
        {readerIndex && playingJob && (
          <Reader
            key={playingJob.id}
            index={readerIndex}
            position={position}
            preview={preview}
            followToken={followToken}
            visible={tab === "reader"}
            fail={fail}
            play={(segment) => {
              if (
                segment.sampleStart === null ||
                segment.sampleEnd! <= segment.sampleStart
              ) {
                setNotice("这部分尚未生成，当前播放不变。");
                return;
              }
              void start(playingJob, segment.sampleStart / 24000);
            }}
          />
        )}
        {tab === "reader" && !readerIndex && <p>正在加载原文索引…</p>}
      </main>
      {playingJob && (
        <footer className="player">
          <div>
            <strong>{playingJob.title}</strong>
            <small>
              {playingJob.speaker} ·{" "}
              {stalls ? `等待音频 ${stalls} 次` : "本地播放"}
            </small>
          </div>
          <button
            className="play-toggle"
            aria-label={paused ? "继续播放" : "暂停播放"}
            onClick={() => {
              if (
                paused &&
                playingJob.completed === playingJob.total &&
                position >= playingJob.samples / 24000
              ) {
                void start(playingJob, 0);
              } else {
                player.current?.pause(playing, !paused);
                setPaused(!paused);
                savePosition(playing, positionRef.current);
              }
            }}
          >
            {paused ? "▶" : "Ⅱ"}
          </button>
          <span>{time(preview ?? position)}</span>
          <SeekBar
            key={playingJob.id}
            position={position}
            duration={playingJob.samples / 24000}
            paused={paused}
            preview={setPreview}
            seek={(seconds, keepPaused) =>
              void start(playingJob, seconds, keepPaused)
            }
          />
          <span>
            {playingJob.completed !== playingJob.total ? "已生成 " : ""}
            {time(playingJob.samples / 24000)}
          </span>
          <button
            onClick={() => {
              savePosition(playing, positionRef.current);
              void player.current?.close();
              setPlaying("");
              playingRef.current = "";
              setPreview(null);
              if (tab === "reader") setTab("tasks");
            }}
          >
            关闭
          </button>
        </footer>
      )}
      {draft && (
        <div className="overlay">
          <section className="modal editor">
            <div className="modal-head">
              <h2>检查正文</h2>
              <button onClick={() => setDraft(undefined)}>关闭</button>
            </div>
            <label>
              书名
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <div className="editor-layout">
              <aside>
                {draft.chapters.map((item, index) => (
                  <button
                    key={index}
                    className={chapter === index ? "active" : ""}
                    onClick={() => setChapter(index)}
                  >
                    {index + 1}. {item.title}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setDraft({
                      ...draft,
                      chapters: [
                        ...draft.chapters,
                        { title: "新章节", text: "" },
                      ],
                    });
                    setChapter(draft.chapters.length);
                  }}
                >
                  ＋ 添加章节
                </button>
              </aside>
              <div>
                {draft.chapters[chapter] && (
                  <>
                    <input
                      aria-label="章节标题"
                      value={draft.chapters[chapter].title}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chapters: draft.chapters.map((c, i) =>
                            i === chapter ? { ...c, title: e.target.value } : c,
                          ),
                        })
                      }
                    />
                    <textarea
                      aria-label="章节正文"
                      value={draft.chapters[chapter].text}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chapters: draft.chapters.map((c, i) =>
                            i === chapter ? { ...c, text: e.target.value } : c,
                          ),
                        })
                      }
                    />
                    <button
                      disabled={draft.chapters.length < 2}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          chapters: draft.chapters.filter(
                            (_, i) => i !== chapter,
                          ),
                        });
                        setChapter(Math.max(0, chapter - 1));
                      }}
                    >
                      排除此章节
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <span>保存为新的书籍版本，不覆盖已有音频。</span>
              <button
                className="primary"
                onClick={async () => {
                  const result = await act<{ id: string }>("save_book", draft);
                  if (result) {
                    setSelected(result.id);
                    setDraft(undefined);
                    setTab("library");
                  }
                }}
              >
                保存到书库
              </button>
            </div>
          </section>
        </div>
      )}
      {settings && (
        <div className="overlay">
          <section className="modal settings">
            <div className="modal-head">
              <h2>设置与模型</h2>
              <button onClick={() => setSettings(undefined)}>关闭</button>
            </div>
            <p className="muted">
              客户端、运行包和模型分别保存。模型约 2.50
              GB，首次准备后可以离线生成。
            </p>
            <div className="actions">
              <button
                disabled={!!state?.setup?.running || !!state?.active}
                onClick={() => void act("install", { flavor: "cuda" })}
              >
                下载 NVIDIA 运行包与模型
              </button>
              <button
                disabled={!!state?.setup?.running || !!state?.active}
                onClick={() => void act("install", { flavor: "cpu" })}
              >
                下载 CPU 运行包与模型
              </button>
            </div>
            {state?.setup && (
              <p className="banner">
                {state.setup.message}
                {state.setup.running && state.setup.total > 0 && (
                  <progress value={state.setup.bytes} max={state.setup.total} />
                )}
              </p>
            )}
            <label>
              书库位置
              <div className="path">
                <input value={settings.library} readOnly />
                <button onClick={() => void chooseSetting("library")}>
                  选择
                </button>
              </div>
            </label>
            <p className="hint">
              切换位置会打开该目录的书库，原有书库保留在原目录。
            </p>
            <details>
              <summary>使用已有模型与运行环境</summary>
              <label>
                模型目录
                <div className="path">
                  <input
                    value={settings.model}
                    onChange={(e) =>
                      setSettings({ ...settings, model: e.target.value })
                    }
                  />
                  <button onClick={() => void chooseSetting("model")}>
                    选择
                  </button>
                </div>
              </label>
              <label>
                推理运行环境 python.exe
                <div className="path">
                  <input
                    value={settings.runtimePython}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        runtimePython: e.target.value,
                      })
                    }
                  />
                  <button onClick={() => void chooseSetting("runtimePython")}>
                    选择
                  </button>
                </div>
              </label>
            </details>
            <label>
              CPU 运算线程
              <input
                type="number"
                min="1"
                max="256"
                value={settings.threads}
                onChange={(e) =>
                  setSettings({ ...settings, threads: Number(e.target.value) })
                }
              />
            </label>
            <p className="fine">
              任务结束五分钟后自动释放模型；无任务时不加载模型。
            </p>
            <div className="modal-foot">
              <button onClick={() => void act("release", {})}>
                立即释放模型
              </button>
              <button
                className="primary"
                onClick={async () => {
                  const result = await act("settings", settings);
                  if (result) setSettings(undefined);
                }}
              >
                保存设置
              </button>
            </div>
          </section>
        </div>
      )}
      {state?.share && (
        <div className="overlay">
          <section className="modal share">
            <h2>把这本书带走</h2>
            <p>
              手机连接同一 Wi-Fi，扫码下载。
              <br />
              保存后用现有播放器打开，即可离线听。
            </p>
            <img
              src={state.share.qr}
              width="240"
              height="240"
              alt="手机下载二维码"
            />
            <input readOnly value={state.share.url} aria-label="下载地址" />
            <p className="fine">
              若无法连接，请检查电脑的私有网络防火墙权限。
              <br />
              也可以在生成任务中直接导出文件。
            </p>
            <button className="primary" onClick={() => void act("unshare", {})}>
              结束分享
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
