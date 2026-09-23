import { writeFile } from "node:fs/promises";
const repositories = [
  "onnx-community/Kokoro-82M-v1.0-ONNX",
  "onnx-community/Kokoro-82M-v1.1-zh-ONNX",
  "rhasspy/piper-voices",
];
const manifest = {};
for (const repo of repositories) {
  const r = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
  if (!r.ok) throw new Error(`${repo}: ${r.status}`);
  const data = await r.json();
  const wanted = repo.startsWith("onnx-community/")
    ? /^(onnx\/model\.onnx|tokenizer\.json|voices\/(zf_xiaoxiao|zm_yunyang|af_heart|bf_emma|zf_001|zm_010)\.bin)$/
    : /^(zh\/zh_CN\/huayan\/medium\/zh_CN-huayan-medium|en\/en_US\/lessac\/high\/en_US-lessac-high)\.onnx(\.json)?$/;
  manifest[repo] = {
    revision: data.sha,
    files: Object.fromEntries(
      data.siblings
        .filter((f) => wanted.test(f.rfilename))
        .map((f) => [f.rfilename, f.size ?? f.lfs?.size ?? null]),
    ),
  };
  console.log(repo, data.sha);
}
await writeFile("src/model-manifest.json", JSON.stringify(manifest, null, 2));
