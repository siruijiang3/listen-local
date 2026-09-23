import { mkdir, writeFile } from "node:fs/promises";
const rev = "bbc3b5da19965257db0c8e6c9fb9381175b165a7";
await mkdir("src/vendor/uzen", { recursive: true });
for (const path of ["src/phonemize.js", "src/zh-data.js", "LICENSE"]) {
  const r = await fetch(
    `https://raw.githubusercontent.com/uzen-zone/kokoro-js/${rev}/${path}`,
  );
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  let content = await r.text();
  if (path.endsWith("phonemize.js")) {
    // Local fix: adverb 轻轻 retains two first tones (Misaki reference).
    content = content.replace(
      "慢慢|刚刚|常|渐渐|万万",
      "慢慢|刚刚|轻轻|常|渐渐|万万",
    );
    content +=
      "\n// Local exports for the separately versioned legacy Chinese adapter.\nexport { normalize_chinese_numbers, normalize_chinese_punctuation };\n";
  }
  await writeFile(`src/vendor/uzen/${path.split("/").pop()}`, content);
}
console.log("Vendored Apache-2.0 pronunciation frontend at", rev);
