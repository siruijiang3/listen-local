import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const source = await readFile("src/samples.ts", "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const { samples } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);
await mkdir(".qa", { recursive: true });
await writeFile(".qa/qwen-inputs.json", JSON.stringify(samples, null, 2));
console.log(
  `Exported ${samples.length} original passages without modifying text.`,
);
