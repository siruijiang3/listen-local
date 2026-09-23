/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/webgpu";
import { getCandidate, assetUrl, rejectedMandarinVoices } from "./catalog";
import { splitText, normalizePcm } from "./audio";
import { kokoroPhonemes } from "./kokoro-phones";
import type { Metrics, RunRequest, WorkerMessage } from "./types";
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: WorkerMessage, transfer: Transferable[] = []) =>
  ctx.postMessage(message, transfer);
let downloadedBytes = 0,
  cachedBytes = 0,
  downloadMs = 0;
const heap = () =>
  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize ?? null;
async function fetchAsset(url: string): Promise<ArrayBuffer> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open("listen-models-v1");
    const cached = await cache.match(url);
    if (cached) {
      const bytes = await cached.arrayBuffer();
      cachedBytes += bytes.byteLength;
      send({
        type: "status",
        label: "读取本地缓存",
        file: url.split("/").at(-1),
      });
      return bytes;
    }
  } catch {
    /* Cache may be unavailable in private browsing. */
  }
  const start = performance.now();
  const response = await fetch(url).catch(() => {
    throw new Error(
      `无法下载 ${url.split("/").at(-1)}。请确认可访问 ${new URL(url).hostname}；已缓存资源仍可本地使用。`,
    );
  });
  if (!response.ok)
    throw new Error(
      `资源下载失败（${response.status}）：${url.split("/").at(-1)}。请检查网络后重试。`,
    );
  const total = Number(response.headers.get("content-length")) || undefined;
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0,
    last = 0;
  if (!reader) throw new Error("浏览器无法读取下载流");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    if (performance.now() - last > 120) {
      send({
        type: "status",
        label: "下载到本机",
        file: url.split("/").at(-1),
        loaded,
        total,
      });
      last = performance.now();
    }
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const p of parts) {
    buffer.set(p, offset);
    offset += p.length;
  }
  downloadedBytes += loaded;
  downloadMs += performance.now() - start;
  try {
    await cache?.put(
      url,
      new Response(buffer, {
        headers: {
          "Content-Type":
            response.headers.get("Content-Type") ?? "application/octet-stream",
        },
      }),
    );
  } catch {
    send({ type: "status", label: "缓存空间不足，本次生成仍可继续" });
  }
  return buffer.buffer;
}
type PiperModule = { callMain(args: string[]): number };
type PiperFactory = (args: Record<string, unknown>) => Promise<PiperModule>;
type PiperConfig = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map: Record<string, number>;
};
let busy = false;
ctx.onmessage = async (event: MessageEvent<RunRequest>) => {
  if (event.data.type !== "run" || busy) return;
  busy = true;
  const req = event.data;
  let session: ort.InferenceSession | undefined;
  try {
    const c = getCandidate(req.engineId);
    if (rejectedMandarinVoices.has(req.voiceId))
      throw new Error("该音色已因方言口音被移出普通话候选，请选择新声音。");
    if (
      !c.voices.some((v) => v.id === req.voiceId && v.language === req.language)
    )
      throw new Error("声音与测试语言不匹配");
    if (!req.text.trim() || req.text.length > 12000)
      throw new Error("请输入 1–12000 个字符");
    const start = performance.now();
    const heapStart = heap();
    let heapPeak = heapStart;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = new URL("/runtime/ort/", ctx.location.origin).href;
    let backend =
      req.backend === "auto" && "gpu" in navigator && !c.id.startsWith("piper")
        ? "webgpu"
        : "wasm";
    const model = await fetchAsset(assetUrl(c, c.model));
    send({
      type: "status",
      label: backend === "webgpu" ? "初始化 GPU 模型" : "初始化 CPU 模型",
    });
    try {
      session = await ort.InferenceSession.create(model, {
        executionProviders:
          backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
      });
    } catch (error) {
      if (backend === "wasm") throw error;
      backend = "wasm";
      send({ type: "status", label: "GPU 不可用，改用 CPU 初始化" });
      session = await ort.InferenceSession.create(model, {
        executionProviders: ["wasm"],
      });
    }
    let vocab: Record<string, number> = {},
      voice: Float32Array | undefined,
      piperConfig: PiperConfig | undefined,
      piper: PiperModule | undefined;
    let piperIds: number[] = [],
      piperError = "";
    if (c.id.startsWith("piper")) {
      piperConfig = JSON.parse(
        new TextDecoder().decode(
          await fetchAsset(assetUrl(c, c.model + ".json")),
        ),
      );
      const base = new URL("/runtime/piper/", ctx.location.origin).href;
      // Sequential transfers keep downloadMs a wall-time sum without overlap.
      const wasmBinary = await fetchAsset(base + "piper_phonemize.wasm");
      const data = await fetchAsset(base + "piper_phonemize.data");
      const { default: create } = (await import(
        /* @vite-ignore */ base + "piper_phonemize.js"
      )) as { default: PiperFactory };
      piper = await create({
        wasmBinary,
        getPreloadedPackage: () => data,
        noInitialRun: true,
        locateFile: (name: string) => base + name,
        print: (line: string) => {
          try {
            const output = JSON.parse(line);
            piperIds.push(...output.phoneme_ids);
          } catch {
            piperError = line;
          }
        },
        printErr: (line: string) => {
          piperError += line;
        },
      });
    } else {
      const tokenizer = JSON.parse(
        new TextDecoder().decode(
          await fetchAsset(assetUrl(c, "tokenizer.json")),
        ),
      );
      vocab = tokenizer.model.vocab;
      voice = new Float32Array(
        await fetchAsset(assetUrl(c, `voices/${req.voiceId}.bin`)),
      );
    }
    const loadMs = performance.now() - start;
    send({ type: "loaded", backend, loadMs });
    const chunks = splitText(req.text, req.language);
    let synthesisMs = 0,
      audioSeconds = 0,
      firstChunkMs = 0,
      completed = 0;
    const metrics = (): Metrics => ({
      loadMs,
      downloadMs,
      synthesisMs,
      firstChunkMs,
      audioSeconds,
      downloadedBytes,
      cachedBytes,
      backend,
      heapStart,
      heapEnd: heap(),
      heapPeak,
      chunks: completed,
    });
    // Split further based on phoneme count rather than silently truncating model inputs.
    const synthesize = async (
      text: string,
    ): Promise<{ pcm: Float32Array; rate: number; text: string }[]> => {
      if (piper && piperConfig) {
        piperIds = [];
        piperError = "";
        piper.callMain([
          "-l",
          piperConfig.espeak.voice,
          "--input",
          JSON.stringify([{ text: text.trim() }]),
          "--espeak_data",
          "/espeak-ng-data",
        ]);
        if (!piperIds.length)
          throw new Error("Piper 发音转换失败：" + piperError);
        const feeds: Record<string, ort.Tensor> = {
          input: new ort.Tensor(
            "int64",
            BigInt64Array.from(piperIds.map(BigInt)),
            [1, piperIds.length],
          ),
          input_lengths: new ort.Tensor(
            "int64",
            BigInt64Array.from([BigInt(piperIds.length)]),
            [1],
          ),
          scales: new ort.Tensor(
            "float32",
            new Float32Array([
              piperConfig.inference.noise_scale,
              piperConfig.inference.length_scale,
              piperConfig.inference.noise_w,
            ]),
            [3],
          ),
        };
        if (session!.inputNames.includes("sid"))
          feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
        const out = await session!.run(feeds);
        const pcm = new Float32Array(
          out[session!.outputNames[0]].data as Float32Array,
        );
        Object.values(out).forEach((t) => t.dispose());
        Object.values(feeds).forEach((t) => t.dispose());
        return [{ pcm, rate: piperConfig.audio.sample_rate, text }];
      }
      const phones = await kokoroPhonemes(
        text,
        req.language,
        c.id,
        req.voiceId,
      );
      const unknown = [...new Set([...phones].filter((p) => !(p in vocab)))];
      if (unknown.length)
        throw new Error(
          `发音前端产生模型不支持的音素：${unknown.join(" ")}。已停止，避免静默漏读。`,
        );
      const ids = [...phones].map((p) => vocab[p]);
      if (ids.length > 500) {
        if (text.length < 2) throw new Error("片段超出模型长度");
        const mid = Math.floor(text.length / 2);
        return [
          ...(await synthesize(text.slice(0, mid))),
          ...(await synthesize(text.slice(mid))),
        ];
      }
      if (!ids.length) throw new Error("文本没有可朗读的音素");
      const index = Math.min(ids.length, 509) * 256;
      const style = voice!.slice(index, index + 256);
      const feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from([0, ...ids, 0].map(BigInt)),
          [1, ids.length + 2],
        ),
        style: new ort.Tensor("float32", style, [1, 256]),
        speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
      };
      const out = await session!.run(feeds);
      const pcm = new Float32Array(
        out[session!.outputNames[0]].data as Float32Array,
      );
      Object.values(out).forEach((t) => t.dispose());
      Object.values(feeds).forEach((t) => t.dispose());
      return [{ pcm, rate: 24000, text }];
    };
    for (let i = 0; i < chunks.length; i++) {
      send({ type: "status", label: `生成第 ${i + 1} / ${chunks.length} 段` });
      const tick = performance.now();
      const results = await synthesize(chunks[i]);
      synthesisMs += performance.now() - tick;
      for (const result of results) {
        const { pcm, gainDb, warnings } = normalizePcm(result.pcm);
        const duration = pcm.length / result.rate;
        if (duration < 0.25 && result.text.trim().length > 5)
          warnings.push("音频过短，可能截断，请核对");
        audioSeconds += duration;
        completed++;
        if (!firstChunkMs) firstChunkMs = performance.now() - start;
        const h = heap();
        if (h !== null) heapPeak = Math.max(heapPeak ?? 0, h);
        send(
          {
            type: "chunk",
            pcm,
            sampleRate: result.rate,
            text: result.text,
            index: i,
            count: chunks.length,
            warnings,
            gainDb,
            metrics: metrics(),
          },
          [pcm.buffer],
        );
      }
    }
    send({ type: "done", metrics: metrics() });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await session?.release();
    busy = false;
  }
};
