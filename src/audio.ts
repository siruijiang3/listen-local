export function normalizePcm(input: Float32Array) {
  const pcm = new Float32Array(input);
  let peak = 0,
    sum = 0,
    active = 0,
    invalid = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i])) {
      invalid++;
      pcm[i] = 0;
    }
    const x = Math.abs(pcm[i]);
    peak = Math.max(peak, x);
    if (x > 0.005) {
      sum += x * x;
      active++;
    }
  }
  if (invalid)
    throw new Error(`模型输出含 ${invalid} 个无效采样，已停止播放。`);
  if (!pcm.length) throw new Error("模型没有返回音频。");
  const rms = Math.sqrt(sum / Math.max(1, active));
  const gain =
    peak > 0 ? Math.min(0.1 / Math.max(rms, 1e-8), 0.94 / peak, 8) : 1;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  const warnings = peak < 0.001 ? ["近乎静音，请检查音频"] : [];
  return { pcm, gainDb: 20 * Math.log10(gain), warnings };
}
export function wavBlob(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) =>
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, v)) * 32767),
      true,
    ),
  );
  return new Blob([buffer], { type: "audio/wav" });
}
export async function mergeWavs(blobs: Blob[]): Promise<Blob> {
  if (!blobs.length) throw new Error("没有可下载的音频");
  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const rate = new DataView(buffers[0]).getUint32(24, true);
  const size = buffers.reduce((n, b) => n + b.byteLength - 44, 0);
  const header = new Uint8Array(buffers[0].slice(0, 44));
  const view = new DataView(header.buffer);
  if (buffers.some((b) => new DataView(b).getUint32(24, true) !== rate))
    throw new Error("采样率不一致");
  view.setUint32(4, 36 + size, true);
  view.setUint32(40, size, true);
  return new Blob([header, ...buffers.map((b) => b.slice(44))], {
    type: "audio/wav",
  });
}
export function splitText(
  text: string,
  language: string,
  maxLength = language === "zh" ? 80 : 220,
): string[] {
  const source = text.trim();
  if (!source) return [];
  const sentences = [
    ...new Intl.Segmenter(language, { granularity: "sentence" }).segment(
      source,
    ),
  ].map((s) => s.segment);
  const out: string[] = [];
  for (let rest of sentences) {
    while (rest.length > maxLength) {
      let at = Math.max(
        rest.lastIndexOf(" ", maxLength),
        rest.lastIndexOf("，", maxLength),
        rest.lastIndexOf(",", maxLength),
        rest.lastIndexOf("；", maxLength),
      );
      if (at < maxLength / 3) at = maxLength;
      else at++;
      if (/[\uD800-\uDBFF]/.test(rest[at - 1])) at--;
      out.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (rest) out.push(rest);
  }
  return out.filter((s) => s.trim());
}
