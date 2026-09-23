import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { decodePacket, segments, wavHeader } from "./realtime-core";
import { samples } from "./samples";
import { half, unhalf, sampleLogits, seeded } from "./qwen-numeric";
describe("realtime text and transport", () => {
  it("keeps FP16 representation and sampled codec IDs within the allowed vocabulary", () => {
    for (const value of [0, 1, -1, 0.5, 65504, 2 ** -14, 2 ** -24])
      expect(unhalf(half(value))).toBe(value);
    expect(half(1 + 2 ** -11)).toBe(half(1));
    expect(half(1 + 3 * 2 ** -11)).toBe(half(1 + 2 ** -9));
    expect(half(2 ** -25)).toBe(0);
    expect(half(3 * 2 ** -25)).toBe(2);
    expect(unhalf(half(70000))).toBe(Infinity);
    expect(unhalf(half(NaN))).toBeNaN();
    expect(() =>
      sampleLogits(new Float32Array([1, NaN, 2]), seeded(42)),
    ).toThrow();
    const logits = new Float32Array(3072).fill(-10);
    logits[2500] = 100;
    logits[3] = 20;
    expect(sampleLogits(logits, seeded(42), [], 2150, 2)).toBe(3);
  });
  it("preserves complete source and ordering for every original passage", () => {
    for (const s of samples) {
      const parts = segments(
        s.text,
        s.language === "zh" ? "Chinese" : "English",
      );
      expect(parts.join("")).toBe(s.text);
      expect(parts.every((p) => p.length <= 1600 && p.trim())).toBe(true);
    }
    const unusual = "  开始。\n\n" + "🙂无标点文字".repeat(400) + "  ";
    expect(segments(unusual, "Chinese").join("")).toBe(unusual);
  });
  it("rejects malformed packets before they reach playback", () => {
    expect(() => decodePacket(new ArrayBuffer(2))).toThrow();
    const h = new TextEncoder().encode(
      JSON.stringify({ samples: 2, sampleRate: 24000 }),
    );
    const b = new ArrayBuffer(h.length + 8);
    new DataView(b).setUint32(0, h.length, true);
    new Uint8Array(b, 4, h.length).set(h);
    expect(() => decodePacket(b)).toThrow(/长度/);
    const wav = new DataView(wavHeader(24000));
    expect(wav.getUint32(40, true)).toBe(48000);
    expect(wav.getUint32(24, true)).toBe(24000);
  });
});
function worklet(rate = 24000) {
  let Processor: any;
  const messages: any[] = [];
  const sandbox = {
    sampleRate: rate,
    currentTime: 0,
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (m: any) => messages.push(m), onmessage: null };
    },
    registerProcessor: (_name: string, p: any) => {
      Processor = p;
    },
  };
  runInNewContext(readFileSync("public/realtime-player.js", "utf8"), sandbox);
  const player = new Processor();
  const send = (m: any) => player.port.onmessage({ data: m });
  const step = () => {
    const pcm = new Float32Array(128);
    player.process([], [[pcm]]);
    sandbox.currentTime += 128 / rate;
    return pcm;
  };
  return { player, send, step, messages };
}
describe("fixed playback ring", () => {
  it("buffers 0.5s, pauses without consumption and rejects previous task chunks", () => {
    const w = worklet();
    w.send({ type: "reset", runId: "a" });
    w.send({
      type: "pcm",
      runId: "old",
      pcm: new Float32Array(24000).fill(0.2),
    });
    expect(w.player.available).toBe(0);
    w.send({ type: "pcm", runId: "a", pcm: new Float32Array(6000).fill(0.2) });
    expect(w.step().every((x) => x === 0)).toBe(true);
    w.send({ type: "pcm", runId: "a", pcm: new Float32Array(6000).fill(0.2) });
    expect(w.step()[0]).toBeCloseTo(0.2);
    w.send({ type: "pause", runId: "a", value: true });
    const played = w.player.played;
    w.step();
    expect(w.player.played).toBe(played);
    w.send({ type: "pause", runId: "a", value: false });
    expect(w.step()[0]).toBeCloseTo(0.2);
    w.send({ type: "reset", runId: "b" });
    expect(w.player.available).toBe(0);
    w.send({ type: "end", runId: "a" });
    expect(w.player.ended).toBe(false);
  });
  it("drains short tails, counts underrun episodes and has fixed memory", () => {
    const w = worklet(48000);
    w.send({ type: "reset", runId: "a" });
    const capacity = w.player.ring.byteLength;
    w.send({ type: "pcm", runId: "a", pcm: new Float32Array(24).fill(0.4) });
    w.send({ type: "end", runId: "a" });
    const out = w.step();
    expect([...out].filter((x) => x !== 0).length).toBe(48);
    expect(w.messages.some((m) => m.type === "finished")).toBe(true);
    w.send({ type: "reset", runId: "b" });
    w.send({ type: "pcm", runId: "b", pcm: new Float32Array(12000).fill(0.1) });
    for (let i = 0; i < 400; i++) w.step();
    expect(w.player.stalls).toBe(1);
    expect(w.player.ring.byteLength).toBe(capacity);
  });
});
