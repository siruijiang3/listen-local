import { describe, expect, it } from "vitest";
import { mergeWavs, normalizePcm, splitText, wavBlob } from "./audio";
import { samples } from "./samples";
import { legacyChinese, syllableToIpa } from "./legacy-zh";
import v1 from "./fixtures/kokoro-v1-tokenizer.json";
import zh from "./fixtures/kokoro-zh-tokenizer.json";
import { normalizePhones, kokoroPhonemes } from "./kokoro-phones";

describe("原文完整性", () => {
  it("所有内置样本分段后不丢失或重复文字", () => {
    for (const sample of samples)
      expect(
        splitText(sample.text, sample.language).join("").replace(/\s/g, ""),
      ).toBe(sample.text.replace(/\s/g, ""));
  });
  it("长句和 Unicode 不截断字符", () => {
    const text = "长句没有句号😀".repeat(200);
    const chunks = splitText(text, "zh");
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every((c) => c.length <= 81 && !/[\uD800-\uDBFF]$/.test(c)),
    ).toBe(true);
  });
  it("每种语言提供五篇短文及一篇长文", () => {
    for (const lang of ["zh", "en"]) {
      expect(
        samples.filter((s) => s.language === lang && !s.long),
      ).toHaveLength(5);
      expect(samples.filter((s) => s.language === lang && s.long)).toHaveLength(
        1,
      );
    }
  });
});
describe("可播放的音频导出", () => {
  it("写出正确采样率和 PCM16 长度", async () => {
    const data = new DataView(
      await wavBlob(new Float32Array([0, 0.5, -0.5]), 24000).arrayBuffer(),
    );
    expect(data.getUint32(24, true)).toBe(24000);
    expect(data.getUint32(40, true)).toBe(6);
    expect(data.getInt16(46, true)).toBe(16384);
  });
  it("合并保留所有音频采样", async () => {
    const b = wavBlob(new Float32Array([0.1, 0.2]), 24000);
    const result = await mergeWavs([b, b, b]);
    expect(result.size).toBe(56);
    expect(new DataView(await result.arrayBuffer()).getUint32(40, true)).toBe(
      12,
    );
  });
  it("拒绝不兼容采样率", async () => {
    await expect(
      mergeWavs([
        wavBlob(new Float32Array([1]), 24000),
        wavBlob(new Float32Array([1]), 22050),
      ]),
    ).rejects.toThrow("采样率");
  });
  it("响度统一且不溢出、不修改原始音频", () => {
    const source = new Float32Array([0.5, -0.5, 0]);
    const { pcm } = normalizePcm(source);
    expect(pcm[0]).toBeCloseTo(0.1);
    expect(source[0]).toBe(0.5);
    expect(
      normalizePcm(new Float32Array([10, 0, 0])).pcm[0],
    ).toBeLessThanOrEqual(0.94);
  });
  it("无效采样报错、静音明确标记", () => {
    expect(() => normalizePcm(new Float32Array([NaN]))).toThrow("无效");
    expect(() => normalizePcm(new Float32Array())).toThrow("没有");
    expect(normalizePcm(new Float32Array(100)).warnings).toHaveLength(1);
  });
});
describe("Kokoro v1.0 中文音素适配", () => {
  it("保留声调及特殊韵母", () => {
    expect(syllableToIpa("zhong1")).toBe("ꭧʊ→ŋ");
    expect(syllableToIpa("guo2")).toBe("kwo↗");
    expect(syllableToIpa("nv3")).toBe("ny↓");
    expect(syllableToIpa("qu4")).toBe("ʨʰy↘");
  });
  it("可转换中文短文和长文", async () => {
    for (const sample of samples.filter(
      (s) => s.language === "zh" && !/[A-Za-z]/.test(s.text),
    ))
      expect((await legacyChinese(sample.text)).length).toBeGreaterThan(10);
  });
});
describe("固定版本词表兼容性", () => {
  it("英文中的汉字保留中文发音", async () => {
    expect(
      await kokoroPhonemes("thank you 谢谢", "en", "kokoro-v1", "af_heart"),
    ).toContain("ɕje↘");
  });
  it("所有内置文字的音素均可被相应模型编码", async () => {
    for (const sample of samples)
      for (const text of splitText(sample.text, sample.language)) {
        const routes =
          sample.language === "zh"
            ? ([
                [
                  await kokoroPhonemes(text, "zh", "kokoro-v1", "zf_xiaoxiao"),
                  v1,
                ],
                [await kokoroPhonemes(text, "zh", "kokoro-zh", "zf_001"), zh],
              ] as const)
            : ([
                [await kokoroPhonemes(text, "en", "kokoro-v1", "af_heart"), v1],
                [await kokoroPhonemes(text, "en", "kokoro-v1", "bf_emma"), v1],
              ] as const);
        for (const [phones, tokenizer] of routes) {
          const vocab = tokenizer.model.vocab as Record<string, number>;
          expect(
            [
              ...new Set(
                [...normalizePhones(phones)].filter((p) => !(p in vocab)),
              ),
            ],
            `${sample.id}: ${text}`,
          ).toEqual([]);
        }
      }
  }, 30000);
});
