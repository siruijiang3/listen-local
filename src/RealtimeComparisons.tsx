import { useEffect, useState } from "react";
type Clip = {
  speaker: string;
  frames: number;
  text: string;
  file: string;
  original: string;
  browserFile?: string;
  seconds: number;
};
export function RealtimeComparisons() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [frames, setFrames] = useState(8);
  useEffect(() => {
    void fetch("/auditions/qwen-realtime/manifest.json")
      .then((r) => (r.ok ? r.json() : undefined))
      .then((m) => setClips(m?.clips ?? []))
      .catch(() => {});
  }, []);
  if (!clips.length) return null;
  return (
    <section className="rt-panel rt-tests">
      <h2>加速前后 · 听感审核</h2>
      <p>
        相同原文与声音。下面是预录对照，不计入上方实时测试；采用原试听页相同响度规则，仅调整导出文件音量。
      </p>
      <label>
        对照音频块
        <select
          value={frames}
          onChange={(e) => setFrames(Number(e.target.value))}
        >
          {[4, 8, 12].map((f) => (
            <option key={f} value={f}>
              {f} 帧
            </option>
          ))}
        </select>
      </label>
      <div className="rt-comparisons">
        {clips
          .filter((c) => c.frames === frames)
          .map((c) => (
            <article key={c.speaker}>
              <h3>{c.speaker}</h3>
              <p>原版 BF16</p>
              <audio controls preload="none" src={c.original} />
              <p>本地加速 BF16 · {frames} 帧</p>
              <audio
                controls
                preload="none"
                src={"/auditions/qwen-realtime/" + c.file}
              />
              {c.browserFile && (
                <>
                  <p>纯浏览器 · {frames} 帧 · 实验样音</p>
                  <audio
                    controls
                    preload="none"
                    src={"/auditions/qwen-realtime/" + c.browserFile}
                  />
                </>
              )}
              <details>
                <summary>对照原文</summary>
                <p>{c.text}</p>
              </details>
            </article>
          ))}
      </div>
      <p>
        请审核自然度、漏读、重复、尾音和块间接缝。当前的速度结果不会自动视为听感通过。
      </p>
    </section>
  );
}
