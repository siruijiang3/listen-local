import * as ort from "qwen-ort/webgpu";
import { floatArray, halfArray, sampleLogits, seeded } from "./qwen-numeric";
import { residualSampler } from "./qwen-sampler-wgsl";

// One-token static graph with a GPU-resident 16-slot residual KV cache.
export class CapturedPredictor {
  private session?: ort.InferenceSession;
  private inputs: Record<string, ort.Tensor> = {};
  private outputs: Record<string, ort.Tensor> = {};
  private buffers: Record<string, any> = {};
  private staging: any;
  private samplePipeline: any;
  private sampleBindings: any;
  private sampleParams: any;
  private codesBuffer: any;
  private codesStaging: any;
  constructor(private device: any) {}
  async prepare(model: ArrayBuffer) {
    const specs: Array<[string, number[], "float16" | "int32"]> = [
      ["embeds", [1, 1, 1024], "float16"],
      ["embedding_id", [1], "int32"],
      ["use_input", [1, 1, 1], "float16"],
      ["head", [1], "int32"],
      ["position", [1], "int32"],
      ["mask", [1, 1, 1, 16], "float16"],
      ["slot", [1, 1, 16, 1], "float16"],
      ["logits", [1, 1, 2048], "float16"],
    ];
    for (let i = 0; i < 10; i++) {
      specs.push(["past_" + i, [1, 8, 16, 128], "float16"]);
      specs.push(["present_" + i, [1, 8, 16, 128], "float16"]);
    }
    for (const [name, dims, dataType] of specs) {
      const size = Math.max(
        16,
        Math.ceil(
          (dims.reduce((a, b) => a * b, 1) * (dataType === "float16" ? 2 : 4)) /
            16,
        ) * 16,
      );
      this.buffers[name] = this.device.createBuffer({
        size,
        usage: 128 | 8 | 4,
      });
      const tensor = ort.Tensor.fromGpuBuffer(this.buffers[name], {
        dataType,
        dims,
      });
      (name === "logits" || name.startsWith("present_")
        ? this.outputs
        : this.inputs)[name] = tensor;
    }
    this.staging = this.device.createBuffer({ size: 4096, usage: 1 | 8 });
    const provider = { name: "webgpu", device: this.device };
    this.session = await ort.InferenceSession.create(model, {
      executionProviders: [provider],
      enableGraphCapture: true,
      preferredOutputLocation: "gpu-buffer",
      extra: { session: { disable_cpu_ep_fallback: "1" } },
    });
    this.codesBuffer = this.device.createBuffer({
      size: 80,
      usage: 128 | 8 | 4,
    });
    this.codesStaging = this.device.createBuffer({ size: 80, usage: 1 | 8 });
    this.sampleParams = this.device.createBuffer({ size: 16, usage: 64 | 8 });
    this.samplePipeline = await this.device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: residualSampler }),
        entryPoint: "main",
      },
    });
    this.sampleBindings = this.device.createBindGroup({
      layout: this.samplePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.logits } },
        { binding: 1, resource: { buffer: this.codesBuffer } },
        { binding: 2, resource: { buffer: this.buffers.embedding_id } },
        { binding: 3, resource: { buffer: this.sampleParams } },
      ],
    });
  }
  private async step(
    embeds: Float32Array,
    position: number,
    previous: number,
    read = true,
    keepEmbeddingId = false,
  ) {
    const mask = new Float32Array(16).fill(-65504);
    mask.fill(0, 0, position + 1);
    const slot = new Float32Array(16);
    slot[position] = 1;
    const data: Record<string, Uint16Array | Int32Array> = {
      embeds: halfArray(embeds),
      embedding_id: Int32Array.of(Math.max(0, position - 2) * 2048 + previous),
      use_input: halfArray([Number(position < 2), 0]),
      head: Int32Array.of(Math.max(0, position - 1)),
      position: Int32Array.of(position),
      mask: halfArray(mask),
      slot: halfArray(slot),
    };
    for (const [name, value] of Object.entries(data))
      if (!(name === "embedding_id" && keepEmbeddingId))
        this.device.queue.writeBuffer(this.buffers[name], 0, value);
    await this.session!.run(this.inputs, this.outputs);
    const encoder = this.device.createCommandEncoder();
    for (let i = 0; i < 10; i++)
      encoder.copyBufferToBuffer(
        this.buffers["present_" + i],
        0,
        this.buffers["past_" + i],
        0,
        32768,
      );
    if (read)
      encoder.copyBufferToBuffer(this.buffers.logits, 0, this.staging, 0, 4096);
    this.device.queue.submit([encoder.finish()]);
    if (!read) return new Float32Array();
    await this.staging.mapAsync(1);
    const result = floatArray(new Uint16Array(this.staging.getMappedRange()));
    this.staging.unmap();
    return result;
  }
  async predict(
    hidden: Float32Array,
    codes: number[],
    group: number | undefined,
    firstEmbedding: Float32Array,
  ) {
    if (group === undefined || group === 1) {
      const encoder = this.device.createCommandEncoder();
      for (let i = 0; i < 10; i++)
        encoder.clearBuffer(this.buffers["past_" + i]);
      this.device.queue.submit([encoder.finish()]);
      await this.step(hidden, 0, 0, false);
    }
    if (group !== undefined)
      return this.step(firstEmbedding, group, group > 1 ? codes[group - 1] : 0);
    const all = new Float32Array(15 * 2048);
    for (let pos = 1; pos < 16; pos++)
      all.set(
        await this.step(firstEmbedding, pos, pos > 1 ? codes[pos - 1] : 0),
        (pos - 1) * 2048,
      );
    return all;
  }
  private sample(group: number, random: number) {
    const params = new ArrayBuffer(16);
    const view = new DataView(params);
    view.setFloat32(0, random, true);
    view.setUint32(4, group, true);
    view.setUint32(8, (group - 1) * 2048, true);
    this.device.queue.writeBuffer(this.sampleParams, 0, params);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.samplePipeline);
    pass.setBindGroup(0, this.sampleBindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  private async readCodes() {
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.codesBuffer, 0, this.codesStaging, 0, 80);
    this.device.queue.submit([encoder.finish()]);
    await this.codesStaging.mapAsync(1);
    const result = Array.from(
      new Uint32Array(this.codesStaging.getMappedRange()),
    );
    this.codesStaging.unmap();
    if (result[16]) throw Error("残差预测器生成了非有限 logits");
    return result.slice(0, 16);
  }
  async verifySampler(logits: Float32Array) {
    const random = seeded(713),
      expected = [0];
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.codesBuffer);
    this.device.queue.submit([encoder.finish()]);
    for (let group = 1; group < 16; group++) {
      const values = logits.slice((group - 1) * 2048, group * 2048),
        r = random();
      expected.push(sampleLogits(values, () => r));
      this.device.queue.writeBuffer(this.buffers.logits, 0, halfArray(values));
      this.sample(group, r);
    }
    const got = await this.readCodes();
    if (JSON.stringify(got) !== JSON.stringify(expected))
      throw Error("GPU top-k 采样与 JavaScript 对照不一致");
  }
  async generateFrame(
    hidden: Float32Array,
    firstEmbedding: Float32Array,
    first: number,
    random: () => number,
    cancelled: () => boolean,
  ) {
    const encoder = this.device.createCommandEncoder();
    for (let i = 0; i < 10; i++) encoder.clearBuffer(this.buffers["past_" + i]);
    encoder.clearBuffer(this.codesBuffer);
    this.device.queue.submit([encoder.finish()]);
    this.device.queue.writeBuffer(this.codesBuffer, 0, Uint32Array.of(first));
    await this.step(hidden, 0, 0, false);
    for (let group = 1; group < 16; group++) {
      if (cancelled()) return null;
      await this.step(firstEmbedding, group, 0, false, group > 1);
      this.sample(group, random());
    }
    return this.readCodes();
  }
  async release() {
    await this.session?.release();
    Object.values(this.inputs).forEach((t) => t.dispose());
    Object.values(this.outputs).forEach((t) => t.dispose());
    Object.values(this.buffers).forEach((b) => b.destroy());
    this.staging?.destroy();
    this.codesBuffer?.destroy();
    this.codesStaging?.destroy();
    this.sampleParams?.destroy();
  }
}
