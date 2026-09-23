// Only the transport representation is uint16; these are IEEE FP16 weights and
// tensors, not integer quantization. CPU orchestration handles small embeddings.
const floatView = new Float32Array(1),
  bitView = new Uint32Array(floatView.buffer);
export function half(n: number) {
  floatView[0] = n;
  const bits = bitView[0],
    sign = (bits >>> 16) & 0x8000;
  const sourceExponent = (bits >>> 23) & 255;
  let exponent = sourceExponent - 127 + 15,
    mantissa = bits & 0x7fffff;
  if (exponent >= 31)
    return sign | 0x7c00 | (sourceExponent === 255 && mantissa ? 0x200 : 0);
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - exponent;
    const rounded = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    return (
      sign |
      (rounded +
        Number(
          remainder > midpoint ||
            (remainder === midpoint && Boolean(rounded & 1)),
        ))
    );
  }
  mantissa += 0xfff + ((mantissa >>> 13) & 1);
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent++;
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}
export function unhalf(n: number) {
  const e = (n >>> 10) & 31,
    m = n & 1023,
    s = n & 32768 ? -1 : 1;
  return (
    s *
    (e === 0
      ? 2 ** -14 * (m / 1024)
      : e === 31
        ? m
          ? NaN
          : Infinity
        : 2 ** (e - 15) * (1 + m / 1024))
  );
}
export function halfArray(values: ArrayLike<number>) {
  return Uint16Array.from(values, half);
}
export function floatArray(data: ArrayLike<number>) {
  return data instanceof Uint16Array
    ? Float32Array.from(data, unhalf)
    : Float32Array.from(data);
}
export function sampleLogits(
  logits: Float32Array,
  random: () => number,
  previous: number[] = [],
  eos = -1,
  minTokens = 0,
) {
  if (!logits.every(Number.isFinite)) throw Error("生成 logits 包含非有限值");
  const scores = Float64Array.from(logits);
  if (eos >= 0) {
    for (let i = scores.length - 1024; i < scores.length; i++)
      if (i !== eos) scores[i] = -Infinity;
    if (previous.length < minTokens) scores[eos] = -Infinity;
  }
  for (const id of new Set(previous))
    scores[id] = scores[id] < 0 ? scores[id] * 1.05 : scores[id] / 1.05;
  const sorted = Array.from(scores, (_, i) => i)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, 50);
  if (!Number.isFinite(scores[sorted[0]])) throw Error("生成 logits 无效");
  const max = scores[sorted[0]];
  const weights = sorted.map((i) => Math.exp((scores[i] - max) / 0.9));
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return sorted[i];
  }
  return sorted[sorted.length - 1];
}
export function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
