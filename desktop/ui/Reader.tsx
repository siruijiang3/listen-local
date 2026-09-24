import { useEffect, useMemo, useRef, useState } from "react";
import { request, type ReaderIndex, type ReaderSegment } from "./api";
import { audibleSegments, segmentAt } from "./reading-index";

const PAGE = 60;
const time = (samples: number, rate: number) => {
  const seconds = Math.floor(samples / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export function Reader({
  index,
  position,
  preview,
  followToken,
  visible,
  play,
  fail,
}: {
  index: ReaderIndex;
  position: number;
  preview: number | null;
  followToken: number;
  visible: boolean;
  play: (segment: ReaderSegment) => void;
  fail: (error: unknown) => void;
}) {
  const [chapter, setChapter] = useState(0);
  const [page, setPage] = useState(0);
  const [follow, setFollow] = useState(true);
  const [text, setText] = useState<{ chapter: number; text: string }>();
  const texts = useRef(new Map<number, string>());
  const activeNode = useRef<HTMLSpanElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const audible = useMemo(
    () => audibleSegments(index.segments),
    [index.segments],
  );
  const active = segmentAt(
    audible,
    Math.floor((preview ?? position) * index.sampleRate),
  );
  const chapterSegments = useMemo(
    () => index.segments.filter((s) => s.chapter === chapter),
    [index.segments, chapter],
  );
  const pageCount = Math.max(1, Math.ceil(chapterSegments.length / PAGE));
  const shown = chapterSegments.slice(page * PAGE, (page + 1) * PAGE);
  const following = follow || preview !== null;
  const paragraphs =
    active && text?.chapter === active.chapter
      ? text.text
          .slice(active.start, active.end)
          .split(/\r\n|\r|\n/)
          .filter((part) => part.trim()).length
      : 0;
  useEffect(() => {
    setFollow(true);
  }, [followToken]);
  useEffect(() => {
    if (!following || !active) return;
    setChapter(active.chapter);
    const local = index.segments
      .filter((s) => s.chapter === active.chapter)
      .findIndex((s) => s.id === active.id);
    setPage(Math.floor(Math.max(0, local) / PAGE));
  }, [active?.id, following, index.segments]);
  useEffect(() => {
    let cancelled = false;
    const cached = texts.current.get(chapter);
    if (cached !== undefined) {
      setText({ chapter, text: cached });
      return;
    }
    void request<{ chapter: number; text: string }>(
      `reader?job=${encodeURIComponent(index.job)}&chapter=${chapter}`,
    )
      .then((data) => {
        if (cancelled) return;
        texts.current.set(chapter, data.text);
        setText(data);
        // Bound source cache as well as the rendered DOM.
        if (texts.current.size > 3)
          texts.current.delete(texts.current.keys().next().value!);
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
  }, [index.job, chapter, fail]);
  useEffect(() => {
    if (following && visible && scroll.current && activeNode.current) {
      const container = scroll.current;
      const rect = activeNode.current.getBoundingClientRect();
      container.scrollTop +=
        rect.top -
        container.getBoundingClientRect().top -
        Math.max(0, (container.clientHeight - rect.height) / 2);
    }
  }, [active?.id, page, text, following, visible]);
  const browse = (next: number, nextPage = 0) => {
    setFollow(false);
    setChapter(next);
    setPage(nextPage);
    scroll.current?.scrollTo(0, 0);
  };
  return (
    <section className="reader" hidden={!visible}>
      <div className="reader-heading">
        <div>
          <h2>{index.title}</h2>
          <p>点击原文，从所属音频片段开头收听 · 可选择和复制</p>
        </div>
        <button onClick={() => setFollow(true)}>
          {follow ? "正在跟随朗读" : "回到正在朗读"}
        </button>
      </div>
      <div className="reader-layout">
        <nav aria-label="章节目录">
          {index.chapters.map((item, i) => (
            <button
              key={i}
              className={chapter === i ? "active" : ""}
              onClick={() => browse(i)}
            >
              {i + 1}. {item.title}
            </button>
          ))}
        </nav>
        <div className="reader-body">
          <h3>{index.chapters[chapter]?.title}</h3>
          <div className="reader-range" aria-live="polite">
            {active ? (
              <>
                <strong>
                  {preview !== null ? "预览" : "当前"}音频片段{" "}
                  {active.position + 1} / {index.total}
                </strong>
                <span>
                  {time(active.sampleStart!, index.sampleRate)}–
                  {time(active.sampleEnd!, index.sampleRate)}
                  {paragraphs > 1 ? ` · 此片段跨 ${paragraphs} 个自然段` : ""}
                </span>
              </>
            ) : (
              <strong>等待生成音频</strong>
            )}
            <small>高亮表示整个音频片段的原文，不是逐句或逐字进度。</small>
          </div>
          <div className="reader-pages">
            <button disabled={!page} onClick={() => browse(chapter, page - 1)}>
              上一部分
            </button>
            <span>
              第 {page + 1} / {pageCount} 部分
            </span>
            <button
              disabled={page + 1 >= pageCount}
              onClick={() => browse(chapter, page + 1)}
            >
              下一部分
            </button>
          </div>
          <div
            className="reader-text"
            ref={scroll}
            tabIndex={0}
            aria-label="原文"
            onWheel={() => setFollow(false)}
            onTouchStart={() => setFollow(false)}
            onPointerDown={() => setFollow(false)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (
                [
                  "PageDown",
                  "PageUp",
                  "ArrowDown",
                  "ArrowUp",
                  "Home",
                  "End",
                  " ",
                ].includes(e.key)
              )
                setFollow(false);
            }}
          >
            {text?.chapter === chapter ? (
              shown.map((segment) => {
                const ready =
                  segment.sampleStart !== null &&
                  segment.sampleEnd! > segment.sampleStart;
                return (
                  <span
                    key={segment.id}
                    ref={active?.id === segment.id ? activeNode : undefined}
                    className={`reader-segment ${active?.id === segment.id ? "current" : ""} ${ready ? "ready" : "pending"}`}
                    data-segment={segment.position}
                    aria-current={
                      active?.id === segment.id ? "true" : undefined
                    }
                    role="button"
                    tabIndex={0}
                    title={ready ? "从此片段开始播放" : "这部分尚未生成"}
                    onClick={() => {
                      if (!window.getSelection()?.toString()) {
                        if (ready) setFollow(true);
                        play(segment);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (ready) setFollow(true);
                        play(segment);
                      }
                    }}
                  >
                    {text.text.slice(segment.start, segment.end)}
                  </span>
                );
              })
            ) : (
              <p>正在加载正文…</p>
            )}
          </div>
          <p className="fine">
            {preview !== null
              ? "正在预览跳转位置"
              : following
                ? "正文随朗读自动定位"
                : "自由浏览中，音频继续播放"}{" "}
            · 浅色正文尚无可播放音频
          </p>
        </div>
      </div>
    </section>
  );
}
