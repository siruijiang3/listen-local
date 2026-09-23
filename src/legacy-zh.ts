// Mandarin IPA mapping follows Misaki (Apache-2.0), adapted from
// pinyin-to-ipa (MIT). See public/THIRD_PARTY.txt and src/vendor licenses.
// Segmentation/polyphones use pinyin-pro, not Python jieba.
import { customPinyin, pinyin } from "pinyin-pro";
import {
  phonemize,
  normalize_chinese_numbers,
  normalize_chinese_punctuation,
} from "./vendor/uzen/phonemize.js";
// Lexical corrections checked against Misaki 0.9.4. Shared by both adapters.
customPinyin({ 行长: "háng zhǎng", 时候: "shí hou" });
const initials: Record<string, string> = {
  b: "p",
  p: "pʰ",
  m: "m",
  f: "f",
  d: "t",
  t: "tʰ",
  n: "n",
  l: "l",
  g: "k",
  k: "kʰ",
  h: "x",
  j: "ʨ",
  q: "ʨʰ",
  x: "ɕ",
  zh: "ꭧ",
  ch: "ꭧʰ",
  sh: "ʂ",
  r: "ɻ",
  z: "ʦ",
  c: "ʦʰ",
  s: "s",
};
const finals: Record<string, string> = {
  a: "a0",
  ai: "ai0",
  an: "a0n",
  ang: "a0ŋ",
  ao: "au0",
  e: "ɤ0",
  ei: "ei0",
  en: "ə0n",
  eng: "ə0ŋ",
  i: "i0",
  ia: "ja0",
  ian: "jɛ0n",
  iang: "ja0ŋ",
  iao: "jau0",
  ie: "je0",
  in: "i0n",
  iou: "jou0",
  ing: "i0ŋ",
  iong: "jʊ0ŋ",
  ong: "ʊ0ŋ",
  ou: "ou0",
  u: "u0",
  uei: "wei0",
  ua: "wa0",
  uai: "wai0",
  uan: "wa0n",
  uen: "wə0n",
  uang: "wa0ŋ",
  ueng: "wə0ŋ",
  uo: "wo0",
  o: "wo0",
  ü: "y0",
  üe: "ɥe0",
  üan: "ɥɛ0n",
  ün: "y0n",
  er: "ɚ0",
  ê: "ɛ0",
  m: "m0",
  n: "n0",
  ng: "ŋ0",
  hm: "hm0",
  hng: "hŋ0",
};
const y: Record<string, string> = {
  yi: "i",
  ya: "ia",
  ye: "ie",
  yao: "iao",
  you: "iou",
  yan: "ian",
  yin: "in",
  yang: "iang",
  ying: "ing",
  yong: "iong",
  yu: "ü",
  yue: "üe",
  yuan: "üan",
  yun: "ün",
};
const w: Record<string, string> = {
  wu: "u",
  wa: "ua",
  wo: "uo",
  wai: "uai",
  wei: "uei",
  wan: "uan",
  wen: "uen",
  wang: "uang",
  weng: "ueng",
};
export function syllableToIpa(value: string): string {
  const tone = /[1-5]$/.test(value) ? Number(value.at(-1)) : 5;
  let s = value.replace(/[0-5]$/, "").replace(/v/g, "ü");
  s = y[s] ?? w[s] ?? s;
  let initial = "";
  if (!["er", "m", "n", "ng", "hm", "hng"].includes(s))
    initial = s.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])/u)?.[0] ?? "";
  let final = s.slice(initial.length);
  if (["j", "q", "x"].includes(initial) && final.startsWith("u"))
    final = "ü" + final.slice(1);
  final =
    ({ iu: "iou", ui: "uei", un: "uen" } as Record<string, string>)[final] ??
    final;
  const phones =
    !initial && final === "o"
      ? "ɔ0"
      : final === "i" &&
          ["zh", "ch", "sh", "r", "z", "c", "s"].includes(initial)
        ? "ɨ0"
        : finals[final];
  if (!phones)
    throw new Error(`中文音素转换失败：${value}。请在反馈中记录此文字。`);
  return (
    (initials[initial] ?? "") +
    phones.replace("0", ["", "→", "↗", "↓", "↘", ""][tone])
  );
}
export async function legacyChinese(
  text: string,
  english: "a" | "b" = "a",
): Promise<string> {
  const normalized = normalize_chinese_punctuation(
    normalize_chinese_numbers(text),
  );
  const pieces =
    normalized.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [];
  const out: string[] = [];
  for (const piece of pieces) {
    if (/\p{Script=Han}/u.test(piece)) {
      // Resolve polyphones and 一/不 sandhi with the entire clause available.
      // Isolating words made the aspect particle 了 become liǎo.
      const syllables = pinyin(piece, {
        toneType: "num",
        type: "array",
        toneSandhi: true,
      });
      let offset = 0;
      for (const word of new Intl.Segmenter("zh", {
        granularity: "word",
      }).segment(piece)) {
        const count = [...word.segment].length;
        out.push(
          syllables
            .slice(offset, offset + count)
            .map(syllableToIpa)
            .join(""),
        );
        offset += count;
      }
    } else
      out.push(/[a-z]/i.test(piece) ? await phonemize(piece, english) : piece);
  }
  return out.join(" ").trim();
}
