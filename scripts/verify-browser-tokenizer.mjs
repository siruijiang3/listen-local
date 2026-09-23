import { readFile } from "node:fs/promises";
import { Tokenizer } from "@huggingface/tokenizers";
const root = "public/models/qwen-webgpu/";
const read = async (name) => JSON.parse(await readFile(root + name, "utf8"));
const tokenizer = new Tokenizer(
  await read("tokenizer.json"),
  await read("tokenizer_config.json"),
);
const fixtures = await read("tokenizer-fixtures.json");
for (const [index, fixture] of fixtures.entries()) {
  const got = tokenizer.encode(fixture.text).ids;
  if (JSON.stringify(got) !== JSON.stringify(fixture.ids))
    throw Error("Tokenizer mismatch at fixture " + index);
}
console.log("Official text token parity:", fixtures.length, "passages passed.");
