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
  private controller?: AbortController;
  private generation = 0;
  private available = 0;
  private complete = false;
  private paused = false;
  constructor(
    private progress: (
      seconds: number,
      stalls: number,
      finished: boolean,
    ) => void,
    private error: (error: unknown) => void,
  ) {}

  update(samples: number, complete: boolean) {
    this.available = Math.max(0, samples) * 2;
    this.complete = complete;
  }

  // Detach synchronously: a late close must never clear a newer session.
  private retire() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.node = undefined;
    const context = this.context;
    this.context = undefined;
    return context && context.state !== "closed"
      ? context.close()
      : Promise.resolve();
  }

  async start(job: string, seconds: number, paused = false) {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const requestedAt = performance.now();
    this.paused = paused;
    try {
      await this.retire();
      if (!current()) return;
      const initial = Math.min(Math.max(0, seconds), this.available / 48000);
      this.metrics = {
        startedAt: new Date().toISOString(),
        initialSeconds: initial,
        playedSeconds: 0,
        stalls: 0,
        finished: false,
      };
      let offset = Math.floor(initial * 24000) * 2;
      let queued = 0,
        read = 0,
        ended = false;
      if (this.complete && offset >= this.available) {
        this.metrics.finished = true;
        this.progress(initial, 0, true);
        return;
      }
      const context = new AudioContext();
      this.context = context;
      const controller = new AbortController();
      this.controller = controller;
      await context.audioWorklet.addModule("/realtime-player.js");
      if (!current()) return;
      const node = new AudioWorkletNode(context, "qwen-realtime-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.node = node;
      node.connect(context.destination);
      node.port.postMessage({ type: "reset", runId: job });
      node.port.postMessage({ type: "pause", runId: job, value: this.paused });
      node.port.onmessage = ({ data }) => {
        if (!current()) return;
        if (data.type === "progress") {
          read = data.playedSeconds;
          this.metrics.playedSeconds = read;
          this.metrics.stalls = data.stalls;
          this.progress(initial + read, data.stalls, false);
        } else if (data.type === "first") {
          const stamp = context.getOutputTimestamp();
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
          this.metrics.playedSeconds = queued;
          this.metrics.finished = true;
          this.progress(initial + queued, this.metrics.stalls, true);
          void this.close();
        } else if (data.type === "overflow")
          this.error(new Error("播放缓冲溢出。"));
      };
      await context.resume();
      if (!current()) return;
      const pump = async () => {
        if (!current()) return;
        try {
          if (queued - read < 24 && offset < this.available) {
            const buffer = await audio(
              job,
              offset,
              Math.min(96000, this.available - offset),
              controller.signal,
            );
            if (!current()) return;
            if (buffer.byteLength) {
              const samples = pcm16(buffer);
              node.port.postMessage({ type: "pcm", runId: job, pcm: samples }, [
                samples.buffer,
              ]);
              offset += buffer.byteLength;
              queued += buffer.byteLength / 48000;
            }
          }
          if (!ended && this.complete && offset >= this.available) {
            node.port.postMessage({ type: "end", runId: job });
            ended = true;
          }
          if (!ended) this.timer = setTimeout(() => void pump(), 50);
        } catch (error) {
          if (current()) {
            this.error(error);
            void this.close();
          }
        }
      };
      void pump();
    } catch (error) {
      if (current()) {
        this.error(error);
        await this.close();
      }
    }
  }

  pause(job: string, value: boolean) {
    this.paused = value;
    this.node?.port.postMessage({ type: "pause", runId: job, value });
  }
  close() {
    ++this.generation;
    return this.retire();
  }
}
