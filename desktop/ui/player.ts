import { audio } from "./api";

export function pcm16(buffer: ArrayBuffer) {
  if (buffer.byteLength % 2) throw new Error("PCM 长度错误。");
  const source = new DataView(buffer);
  return Float32Array.from({ length: buffer.byteLength / 2 }, (_, i) => {
    const sample = source.getInt16(i * 2, true);
    return sample / (sample < 0 ? 32768 : 32767);
  });
}

export class Player {
  metrics: {
    startedAt: string;
    initialSeconds: number;
    playedSeconds: number;
    stalls: number;
    firstOutputSeconds?: number;
    finished: boolean;
  } = {
    startedAt: "",
    initialSeconds: 0,
    playedSeconds: 0,
    stalls: 0,
    finished: false,
  };
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private offset = 0;
  private queued = 0;
  private read = 0;
  private ended = false;
  private initial = 0;
  private available = 0;
  private complete = false;
  constructor(
    private progress: (
      seconds: number,
      stalls: number,
      finished: boolean,
    ) => void,
    private error: (error: unknown) => void,
  ) {}

  update(samples: number, complete: boolean) {
    this.available = samples * 2;
    this.complete = complete;
  }
  async start(job: string, seconds: number) {
    const requestedAt = performance.now();
    await this.close();
    this.metrics = {
      startedAt: new Date().toISOString(),
      initialSeconds: seconds,
      playedSeconds: 0,
      stalls: 0,
      finished: false,
    };
    const generation = ++this.generation;
    this.initial = seconds;
    this.offset = Math.floor(seconds * 24000) * 2;
    this.queued = this.read = 0;
    this.ended = false;
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/realtime-player.js");
    if (generation !== this.generation) return;
    this.node = new AudioWorkletNode(this.context, "qwen-realtime-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.connect(this.context.destination);
    this.node.port.postMessage({ type: "reset", runId: job });
    this.node.port.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      if (data.type === "progress") {
        this.read = data.playedSeconds;
        this.metrics.playedSeconds = this.read;
        this.metrics.stalls = data.stalls;
        this.progress(this.initial + this.read, data.stalls, false);
      } else if (data.type === "first" && this.context) {
        const stamp = this.context.getOutputTimestamp();
        const outputAt =
          stamp.performanceTime && stamp.contextTime != null
            ? stamp.performanceTime +
              (data.audioTime - stamp.contextTime) * 1000
            : performance.now();
        this.metrics.firstOutputSeconds = Math.max(
          0,
          (outputAt - requestedAt) / 1000,
        );
      } else if (data.type === "finished") {
        this.metrics.playedSeconds = this.queued;
        this.metrics.finished = true;
        this.progress(this.initial + this.queued, this.metrics.stalls, true);
        void this.close();
      } else if (data.type === "overflow")
        this.error(new Error("播放缓冲溢出。"));
    };
    await this.context.resume();
    const pump = async () => {
      if (generation !== this.generation) return;
      try {
        if (this.queued - this.read < 24 && this.offset < this.available) {
          const buffer = await audio(
            job,
            this.offset,
            Math.min(96000, this.available - this.offset),
          );
          if (generation !== this.generation) return;
          if (buffer.byteLength) {
            const samples = pcm16(buffer);
            this.node?.port.postMessage(
              { type: "pcm", runId: job, pcm: samples },
              [samples.buffer],
            );
            this.offset += buffer.byteLength;
            this.queued += buffer.byteLength / 48000;
          }
        }
        if (!this.ended && this.complete && this.offset >= this.available) {
          this.node?.port.postMessage({ type: "end", runId: job });
          this.ended = true;
        }
        if (!this.ended) this.timer = setTimeout(() => void pump(), 50);
      } catch (error) {
        this.error(error);
      }
    };
    void pump();
  }
  pause(job: string, value: boolean) {
    this.node?.port.postMessage({ type: "pause", runId: job, value });
  }
  async close() {
    this.generation++;
    clearTimeout(this.timer);
    this.node?.disconnect();
    this.node = undefined;
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.context = undefined;
  }
}
