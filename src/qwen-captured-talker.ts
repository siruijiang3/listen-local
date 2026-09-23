import * as ort from "qwen-ort/webgpu";
import { floatArray, halfArray } from "./qwen-numeric";

// Fixed 2048-slot main decoder KV cache; input/output GPU bindings stay stable.
export class CapturedTalker {
  private session?: ort.InferenceSession;
  private inputs: Record<string, ort.Tensor> = {};
  private outputs: Record<string, ort.Tensor> = {};
  private buffers: Record<string, any> = {};
  private staging: any;
  private size = 2048;
  private cacheBytes = 8 * 2048 * 128 * 2;
  private seen = 0;
  constructor(private device: any) {}
  async prepare(model: ArrayBuffer) {
    const specs: Array<[string, number[], "float16" | "int32"]> = [
      ["embeds", [1, 1, 1024], "float16"],
      ["positions", [3, 1, 1], "int32"],
      ["mask", [1, 1, 1, this.size], "float16"],
      ["slot", [1, 1, this.size, 1], "float16"],
      ["logits", [1, 1, 3072], "float16"],
      ["hidden", [1, 1, 1024], "float16"],
    ];
    for (let i = 0; i < 56; i++) {
      specs.push(["past_" + i, [1, 8, this.size, 128], "float16"]);
      specs.push(["present_" + i, [1, 8, this.size, 128], "float16"]);
    }
    for (const [name, dims, dataType] of specs) {
      const bytes =
        dims.reduce((a, b) => a * b, 1) * (dataType === "float16" ? 2 : 4);
      this.buffers[name] = this.device.createBuffer({
        size: Math.max(16, Math.ceil(bytes / 16) * 16),
        usage: 128 | 8 | 4,
      });
      const tensor = ort.Tensor.fromGpuBuffer(this.buffers[name], {
        dataType,
        dims,
      });
      (name === "logits" || name === "hidden" || name.startsWith("present_")
        ? this.outputs
        : this.inputs)[name] = tensor;
    }
    this.staging = this.device.createBuffer({ size: 8192, usage: 1 | 8 });
    const provider = { name: "webgpu", device: this.device };
    this.session = await ort.InferenceSession.create(model, {
      executionProviders: [provider],
      enableGraphCapture: true,
      preferredOutputLocation: "gpu-buffer",
      extra: { session: { disable_cpu_ep_fallback: "1" } },
    });
  }
  seed(past: ort.Tensor[]) {
    this.seen = Number(past[0].dims[2]);
    if (this.seen >= this.size) throw Error("WebGPU 静态 KV 长度超限");
    const encoder = this.device.createCommandEncoder();
    for (let i = 0; i < 56; i++) {
      encoder.clearBuffer(this.buffers["past_" + i]);
      for (let head = 0; head < 8; head++) {
        encoder.copyBufferToBuffer(
          past[i].gpuBuffer,
          head * this.seen * 256,
          this.buffers["past_" + i],
          head * this.size * 256,
          this.seen * 256,
        );
      }
    }
    this.device.queue.submit([encoder.finish()]);
  }
  async run(embeds: Float32Array, position: number) {
    if (this.seen >= this.size)
      throw Error("WebGPU 静态 KV 长度超限，未标记完成");
    const mask = new Float32Array(this.size).fill(-65504);
    mask.fill(0, 1, this.seen + 1);
    const slot = new Float32Array(this.size);
    slot[this.seen] = 1;
    this.device.queue.writeBuffer(this.buffers.embeds, 0, halfArray(embeds));
    this.device.queue.writeBuffer(
      this.buffers.positions,
      0,
      Int32Array.of(position, position, position),
    );
    this.device.queue.writeBuffer(this.buffers.mask, 0, halfArray(mask));
    this.device.queue.writeBuffer(this.buffers.slot, 0, halfArray(slot));
    await this.session!.run(this.inputs, this.outputs);
    const encoder = this.device.createCommandEncoder();
    for (let i = 0; i < 56; i++)
      encoder.copyBufferToBuffer(
        this.buffers["present_" + i],
        0,
        this.buffers["past_" + i],
        0,
        this.cacheBytes,
      );
    encoder.copyBufferToBuffer(this.buffers.logits, 0, this.staging, 0, 6144);
    encoder.copyBufferToBuffer(
      this.buffers.hidden,
      0,
      this.staging,
      6144,
      2048,
    );
    this.device.queue.submit([encoder.finish()]);
    await this.staging.mapAsync(1);
    const values = floatArray(new Uint16Array(this.staging.getMappedRange()));
    this.staging.unmap();
    this.seen++;
    return { logits: values.slice(0, 3072), hidden: values.slice(3072) };
  }
  async release() {
    await this.session?.release();
    Object.values(this.inputs).forEach((t) => t.dispose());
    Object.values(this.outputs).forEach((t) => t.dispose());
    Object.values(this.buffers).forEach((b) => b.destroy());
    this.staging?.destroy();
  }
}
