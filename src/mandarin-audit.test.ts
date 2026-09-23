import { describe, expect, it } from "vitest";
import {
  candidates,
  defaultSelection,
  defaultVoices,
  rejectedMandarinVoices,
} from "./catalog";
import { kokoroPhonemes } from "./kokoro-phones";
import { legacyChinese } from "./legacy-zh";
import reference from "./fixtures/mandarin-reference.json";

describe("普通话修复回归", () => {
  it("拒绝的地方口音不再进入候选或默认选择", () => {
    for (const id of ["zf_xiaobei", "zf_xiaoni"]) {
      expect(rejectedMandarinVoices.has(id)).toBe(true);
      expect(candidates.flatMap((c) => c.voices).some((v) => v.id === id)).toBe(
        false,
      );
      expect(Object.values(defaultVoices)).not.toContain(id);
    }
    expect(defaultSelection("zh")).toEqual(["kokoro-zh"]);
  });

  // Word boundaries differ between Intl.Segmenter and Python jieba. This checks
  // syllables/tones only; it is deliberately NOT a prosody or listening test.
  it.each(reference.cases)(
    "v1.1 音节和声调对照官方前端：$text",
    async ({ text, v11 }) => {
      const phones = await kokoroPhonemes(text, "zh", "kokoro-zh", "zf_001");
      const syllables = (s: string) => s.replace(/[\s/]/g, "");
      expect(syllables(phones)).toBe(syllables(v11));
    },
  );

  it("v1.0 保留句子上下文：了、不、轻声和行长", async () => {
    const phones = (
      await legacyChinese("雨停的时候不是晚上，行长多了一封信。")
    ).replace(/\s/g, "");
    expect(phones).toContain("ʂɨ↗xou");
    expect(phones).not.toContain("ʂɨ↗xou↘");
    expect(phones).toContain("pu↗ʂɨ↘");
    expect(phones).toContain("xa↗ŋꭧa↓ŋ");
    expect(phones).toContain("two→lɤ");
    expect(phones).not.toContain("ljau↓");
  });
});
