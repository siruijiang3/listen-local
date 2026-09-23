import manifest from "./model-manifest.json";
import type { Candidate } from "./types";
export const candidates: Candidate[] = [
  {
    id: "kokoro-v1",
    name: "Kokoro",
    subtitle: "v1.0 · 多语言基线",
    repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
    model: "onnx/model.onnx",
    languages: "中、英、法、西、日等；不含俄语",
    frontend:
      "英语 eSpeak / 中文 legacy 音素映射 + pinyin-pro · mandarin-fix-2",
    source: "https://huggingface.co/hexgrad/Kokoro-82M",
    voices: [
      { id: "zf_xiaoxiao", label: "晓晓 · 女声（待审）", language: "zh" },
      { id: "zm_yunyang", label: "云扬 · 男声（待审）", language: "zh" },
      { id: "af_heart", label: "Heart · 美式女声", language: "en" },
      { id: "bf_emma", label: "Emma · 英式女声", language: "en" },
    ],
  },
  {
    id: "kokoro-zh",
    name: "Kokoro 中文版",
    subtitle: "v1.1-zh · 中文专用",
    repo: "onnx-community/Kokoro-82M-v1.1-zh-ONNX",
    model: "onnx/model.onnx",
    languages: "中文、英文；本轮审核中文",
    frontend: "uzen bbc3b5d + mandarin-fix-2（非官方 Python 前端）",
    source: "https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh",
    voices: [
      { id: "zf_001", label: "001 · 女声（有官方参考）", language: "zh" },
      { id: "zm_010", label: "010 · 男声（有官方参考）", language: "zh" },
    ],
  },
  {
    id: "piper-zh",
    name: "Piper",
    subtitle: "Huayan · 中文基线",
    repo: "rhasspy/piper-voices",
    model: "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
    languages: "此权重仅中文；其他语言需独立权重",
    frontend: "piper-phonemize WASM 1.0.0 / eSpeak NG",
    source:
      "https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium",
    voices: [{ id: "huayan", label: "Huayan · 中文（待审）", language: "zh" }],
  },
  {
    id: "piper-en",
    name: "Piper",
    subtitle: "Lessac high · 英文基线",
    repo: "rhasspy/piper-voices",
    model: "en/en_US/lessac/high/en_US-lessac-high.onnx",
    languages: "此权重仅英文；其他语言需独立权重",
    frontend: "piper-phonemize WASM 1.0.0 / eSpeak NG",
    source:
      "https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/high",
    voices: [{ id: "lessac", label: "Lessac · 美式英语", language: "en" }],
  },
];
// User rejected these accents. Keep historical recordings, never offer them again.
export const rejectedMandarinVoices = new Set(["zf_xiaobei", "zf_xiaoni"]);
export const defaultVoices = {
  "kokoro-v1": "zf_xiaoxiao",
  "kokoro-zh": "zf_001",
  "piper-zh": "huayan",
  "piper-en": "lessac",
};
export const defaultSelection = (language: "zh" | "en"): Candidate["id"][] =>
  language === "zh" ? ["kokoro-zh"] : ["kokoro-v1", "piper-en"];
export const getCandidate = (id: string) => {
  const c = candidates.find((c) => c.id === id);
  if (!c) throw new Error("未知模型");
  return c;
};
const repoInfo = (repo: string) =>
  (
    manifest as Record<
      string,
      { revision: string; files: Record<string, number | null> }
    >
  )[repo];
export const revisionOf = (c: Candidate) => repoInfo(c.repo).revision;
export const assetUrl = (c: Candidate, path: string) =>
  `https://huggingface.co/${c.repo}/resolve/${revisionOf(c)}/${path}`;
export const modelBytes = (c: Candidate) =>
  repoInfo(c.repo).files[c.model] ?? 0;
export const formatBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
