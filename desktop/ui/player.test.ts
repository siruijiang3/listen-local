import { describe, expect, it } from "vitest";
import { pcm16 } from "./player";
describe("PCM boundary conversion", () => {
  it("decodes signed little-endian endpoints without clipping or offset", () => {
    const bytes = new Uint8Array([0, 128, 0, 0, 255, 127]);
    expect(Array.from(pcm16(bytes.buffer))).toEqual([-1, 0, 1]);
  });
  it("rejects truncated samples", () =>
    expect(() => pcm16(new ArrayBuffer(3))).toThrow());
});
