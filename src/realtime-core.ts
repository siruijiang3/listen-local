export type Mode = "local" | "browser";
export interface RequestSpec {
  runId: string;
  language: "Chinese" | "English";
  speaker: string;
  frames: number;
  segments: string[];
}
export interface EngineEvent {
  type: string;
  runId?: string;
  seq?: number;
  sampleRate?: number;
  pcm?: Float32Array;
  [key: string]: unknown;
}
export interface Engine {
  prepare(): Promise<void>;
  start(request: RequestSpec): void;
  flow(runId: string, playedSeconds: number): void;
  cancel(): void;
  release(): Promise<void>;
}

// Preserve every character, including whitespace and punctuation. Merge natural
// sentences into modest paragraphs; never silently discard a long input tail.
export function segments(text: string, language: string): string[] {
  if (!text.trim()) return [];
  const limit = language === "Chinese" ? 180 : 650;
  const sentences = Array.from(
    new Intl.Segmenter(language === "Chinese" ? "zh" : "en", {
      granularity: "sentence",
    }).segment(text),
    (s) => s.segment,
  );
  const parts: string[] = [];
  let pending = "";
  for (const sentence of sentences) {
    if (pending.length + sentence.length > limit && pending.trim()) {
      parts.push(pending);
      pending = "";
    }
    pending += sentence;
    while (pending.length > limit * 2) {
      // Exceptional unpunctuated input: retain all code points and prefer a space.
      const chars = Array.from(pending);
      let end = Math.min(limit, chars.length);
      const space = chars.slice(0, end).lastIndexOf(" ");
      if (space > end / 2) end = space + 1;
      parts.push(chars.slice(0, end).join(""));
      pending = chars.slice(end).join("");
    }
  }
  if (pending.trim()) parts.push(pending);
  else if (pending && parts.length) parts[parts.length - 1] += pending;
  return parts;
}

export function decodePacket(buffer: ArrayBuffer): EngineEvent {
  if (buffer.byteLength < 4) throw Error("无效音频包");
  const length = new DataView(buffer).getUint32(0, true);
  if (length > buffer.byteLength - 4) throw Error("无效音频包头");
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, length)),
  );
  const pcmBytes = buffer.slice(4 + length);
  if (
    pcmBytes.byteLength % 4 ||
    header.samples * 4 !== pcmBytes.byteLength ||
    header.sampleRate !== 24000
  )
    throw Error("PCM 格式或长度错误");
  const pcm = new Float32Array(pcmBytes);
  if (!pcm.every(Number.isFinite)) throw Error("非有限 PCM");
  return { ...header, pcm };
}

export class LocalEngine implements Engine {
  private socket?: WebSocket;
  private closed = false;
  constructor(private emit: (event: EngineEvent) => void) {}
  async prepare() {
    this.closed = false;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      const ws = (this.socket = new WebSocket("ws://127.0.0.1:8765"));
      ws.binaryType = "arraybuffer";
      ws.onmessage = (e) => {
        try {
          this.emit(
            typeof e.data === "string"
              ? JSON.parse(e.data)
              : decodePacket(e.data),
          );
        } catch (error) {
          this.emit({ type: "error", message: String(error) });
          this.cancel();
        }
      };
      ws.onclose = () => {
        if (!this.closed)
          this.emit({
            type: "error",
            message: "本地服务已断开；本次生成已停止。",
          });
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () =>
          reject(
            Error("无法连接本地服务。请运行 scripts/start-realtime.ps1。"),
          );
      });
    }
    this.send({ type: "prepare" });
  }
  private send(data: object) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(data));
  }
  start(request: RequestSpec) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw Error("本地连接已关闭，请重新准备模型");
    this.send({ type: "start", ...request });
  }
  flow(runId: string, playedSeconds: number) {
    this.send({ type: "flow", runId, playedSeconds });
  }
  cancel() {
    this.send({ type: "cancel" });
  }
  async release() {
    this.closed = true;
    const ws = this.socket;
    if (ws?.readyState === WebSocket.OPEN)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ws.close();
          resolve();
        }, 15000);
        const finish = () => {
          clearTimeout(timer);
          ws.close();
          resolve();
        };
        ws.addEventListener("message", (e) => {
          if (
            typeof e.data === "string" &&
            JSON.parse(e.data).type === "released"
          )
            finish();
        });
        ws.addEventListener("close", finish, { once: true });
        this.send({ type: "release" });
      });
    ws?.close();
    this.socket = undefined;
  }
}

export class BrowserEngine implements Engine {
  private worker: Worker;
  constructor(emit: (event: EngineEvent) => void) {
    this.worker = new Worker(
      new URL("./qwen-browser.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (e) => emit(e.data);
    this.worker.onerror = (e) => emit({ type: "error", message: e.message });
  }
  async prepare() {
    this.worker.postMessage({ type: "prepare" });
  }
  start(request: RequestSpec) {
    this.worker.postMessage({ type: "start", ...request });
  }
  flow(runId: string, playedSeconds: number) {
    this.worker.postMessage({ type: "flow", runId, playedSeconds });
  }
  cancel() {
    this.worker.postMessage({ type: "cancel" });
  }
  simulateDeviceLoss() {
    this.worker.postMessage({ type: "diagnose-device-loss" });
  }
  async release() {
    this.worker.terminate();
  }
}

export function wavHeader(samples: number, sampleRate = 24000) {
  if (samples * 2 > 0xffffffff - 36) throw Error("WAV 超过 4 GB，请分次导出");
  const data = new ArrayBuffer(44);
  const v = new DataView(data);
  const str = (offset: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  return data;
}

export class AudioArchive {
  private count = 0;
  samples = 0;
  private directory!: FileSystemDirectoryHandle;
  async open(runId: string) {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("qwen-realtime-v1", {
      create: true,
    });
    this.directory = await sessions.getDirectoryHandle(runId, { create: true });
  }
  async append(pcm: Float32Array) {
    const raw = new ArrayBuffer(pcm.length * 2);
    const view = new DataView(raw);
    for (let i = 0; i < pcm.length; i++)
      view.setInt16(
        i * 2,
        Math.round(
          Math.max(-1, Math.min(1, pcm[i])) * (pcm[i] < 0 ? 32768 : 32767),
        ),
        true,
      );
    const file = await this.directory.getFileHandle(`${this.count}.pcm`, {
      create: true,
    });
    const writer = await file.createWritable();
    await writer.write(raw);
    await writer.close();
    this.count++;
    this.samples += pcm.length;
  }
  async metadata(data: unknown) {
    const file = await this.directory.getFileHandle("measurement.json", {
      create: true,
    });
    const writer = await file.createWritable();
    await writer.write(JSON.stringify(data, null, 2));
    await writer.close();
  }
  async wav() {
    const end = this.count,
      sampleCount = this.samples;
    const file = await this.directory.getFileHandle("export.wav", {
      create: true,
    });
    const writer = await file.createWritable();
    await writer.write(wavHeader(sampleCount));
    // Read one stored chunk at a time; an entire book never becomes a JS array.
    for (let i = 0; i < end; i++) {
      const chunk = await (
        await this.directory.getFileHandle(`${i}.pcm`)
      ).getFile();
      await writer.write(chunk);
    }
    await writer.close();
    return file.getFile();
  }
}
