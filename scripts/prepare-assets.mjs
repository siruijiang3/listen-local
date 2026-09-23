import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
await mkdir("public/runtime/piper", { recursive: true });
await mkdir("public/runtime/ort", { recursive: true });
const base = "node_modules/@diffusionstudio/piper-wasm/build/";
for (const file of ["piper_phonemize.wasm", "piper_phonemize.data"])
  await copyFile(base + file, "public/runtime/piper/" + file);
const code = await readFile(base + "piper_phonemize.js", "utf8");
await writeFile(
  "public/runtime/piper/piper_phonemize.js",
  code + "\nexport default createPiperPhonemize;\n",
);
for (const file of [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
]) {
  await copyFile(
    "node_modules/onnxruntime-web/dist/" + file,
    "public/runtime/ort/" + file,
  );
}
console.log("Local browser runtime assets ready.");
await mkdir("public/runtime/ort-qwen/1.30.0", { recursive: true });
for (const file of (await readdir("node_modules/qwen-ort/dist")).filter(
  (n) => n.startsWith("ort-wasm-") && /\.(wasm|mjs)$/.test(n),
))
  await copyFile(
    "node_modules/qwen-ort/dist/" + file,
    "public/runtime/ort-qwen/1.30.0/" + file,
  );
await mkdir("public/licenses", { recursive: true });
for (const [source, target] of [
  ["LICENSE", "APPLICATION-GPL-3.0.txt"],
  ["src/vendor/uzen/LICENSE", "UZEN-APACHE-2.0.txt"],
  ["src/vendor/MISAKI-LICENSE", "MISAKI-APACHE-2.0.txt"],
  ["src/vendor/PINYIN-TO-IPA-LICENSE", "PINYIN-TO-IPA-MIT.txt"],
  ["node_modules/react/LICENSE", "REACT-MIT.txt"],
  ["src/vendor/ONNXRUNTIME-LICENSE", "ONNXRUNTIME-MIT.txt"],
  [
    "node_modules/@diffusionstudio/piper-wasm/package.json",
    "PIPER-WASM-PACKAGE.json",
  ],
  ["node_modules/pinyin-pro/LICENSE", "PINYIN-PRO-MIT.txt"],
  ["node_modules/phonemizer/LICENSE", "PHONEMIZER-APACHE-2.0.txt"],
])
  await copyFile(source, "public/licenses/" + target);
