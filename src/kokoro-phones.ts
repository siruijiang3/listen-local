import { phonemize } from "./vendor/uzen/phonemize.js";
import { legacyChinese } from "./legacy-zh";
import type { EngineId, Language } from "./types";

// eSpeak sometimes emits syllabicity diacritics absent from Kokoro's vocabulary.
// The upstream tokenizer drops these too. Preserve the base consonant and all
// words; collapse layout whitespace rather than allowing invisible OOV tokens.
export const normalizePhones = (phones: string) =>
  phones
    .replace(/[\u0329\u032f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export async function kokoroPhonemes(
  text: string,
  language: Language,
  engine: EngineId,
  voice: string,
) {
  const english = voice.startsWith("b") ? "b" : "a";
  if (engine === "kokoro-zh")
    return normalizePhones(await phonemize(text, "z"));
  // Mandarin embedded in an English passage must not be read as letter names.
  if (language === "zh" || /\p{Script=Han}/u.test(text))
    return normalizePhones(await legacyChinese(text, english));
  return normalizePhones(await phonemize(text, english));
}
