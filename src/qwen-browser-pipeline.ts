import * as ort from "qwen-ort/webgpu";
import { Tokenizer } from "@huggingface/tokenizers";
import { CapturedDecoder } from "./qwen-captured-decoder";
import { CapturedPredictor } from "./qwen-captured-predictor";
import { CapturedTalker } from "./qwen-captured-talker";
import { floatArray, halfArray, sampleLogits, seeded } from "./qwen-numeric";
import type { RequestSpec } from "./realtime-core";
type Emit = (event: Record<string, unknown>, transfer?: Transferable[]) => void;
type Asset = (name: string) => Promise<ArrayBuffer>;
type Session = ort.InferenceSession;
type Tensor = ort.Tensor;
const i64 = (values: number[], dims: number[]) =>
  new ort.Tensor("int64", BigInt64Array.from(values, BigInt), dims);
const i32 = (values: number[], dims: number[]) =>
  new ort.Tensor("int32", Int32Array.from(values), dims);
const fp16 = (values: ArrayLike<number>, dims: number[]) =>
  new ort.Tensor("float16", halfArray(values), dims);
const release = (values: Record<string, Tensor>) =>
  Object.values(values).forEach((v) => v.dispose());
const H = 1024;
export class QwenBrowserPipeline {
  private sessions: Record<string, Session> = {};
  private tokenizer!: Tokenizer;
  private cfg: any;
  private version = 0;
  private currentId = "";
  private played = 0;
  private serial = Promise.resolve();
  private device?: unknown;
  private capturedDecoder?: CapturedDecoder;
  private capturedPredictor?: CapturedPredictor;
  private capturedTalker?: CapturedTalker;
  constructor(private emit: Emit) {}
  async prepare(readAsset: Asset) {
    const prepareStarted = performance.now();
    let resourceSeconds = 0;
    const asset: Asset = async (name) => {
      const tick = performance.now();
      try {
        return await readAsset(name);
      } finally {
        resourceSeconds += (performance.now() - tick) / 1000;
      }
    };
    const gpu = (
      navigator as unknown as {
        gpu: { requestAdapter(options: object): Promise<any> };
      }
    ).gpu;
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw Error("没有可用的 WebGPU 适配器");
    if (!adapter.features.has("shader-f16"))
      throw Error(
        "此 WebGPU 适配器不支持 shader-f16，不能运行未量化的 FP16 生成器",
      );
    this.device = await adapter.requestDevice({
      requiredFeatures: ["shader-f16", "subgroups", "subgroups-f16"].filter(
        (f) => adapter.features.has(f),
      ),
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    const info = adapter.info ?? {};
    this.emit({
      type: "progress",
      adapter: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      },
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      features: Array.from(adapter.features),
    });
    this.cfg = JSON.parse(new TextDecoder().decode(await asset("config.json")));
    this.tokenizer = new Tokenizer(
      JSON.parse(new TextDecoder().decode(await asset("tokenizer.json"))),
      JSON.parse(
        new TextDecoder().decode(await asset("tokenizer_config.json")),
      ),
    );
    const fixtures = JSON.parse(
      new TextDecoder().decode(await asset("tokenizer-fixtures.json")),
    );
    for (const fixture of fixtures) {
      if (
        JSON.stringify(this.tokenizer.encode(fixture.text).ids) !==
        JSON.stringify(fixture.ids)
      )
        throw Error("浏览器 tokenizer 与官方测试原文不一致");
    }
    this.emit({ type: "progress", tokenizerParity: fixtures.length });
    // The real FP32 codec is the first gate, before loading >1 GB of generators.
    let loadingSeconds = 0;
    let codecWarmupSeconds = 0;
    for (const name of [
      "decoder",
      "text-embed",
      "codec-embed",
      "talker-cache",
      "predictor",
      "residual",
    ]) {
      this.emit({
        type: "status",
        phase: "loading",
        message: "WebGPU：加载 " + name + "（禁止 CPU 算子回退）",
      });
      const model = await asset(name + ".onnx");
      const preferred: Record<string, "gpu-buffer"> = {};
      if (name === "talker-cache")
        for (let i = 0; i < 56; i++) preferred["present_" + i] = "gpu-buffer";
      const provider = { name: "webgpu", device: this.device };
      const loadStart = performance.now();
      this.sessions[name] = await ort.InferenceSession.create(model, {
        executionProviders: [provider],
        logSeverityLevel: 2,
        ...(name === "talker-cache"
          ? { preferredOutputLocation: preferred }
          : {}),
        extra: { session: { disable_cpu_ep_fallback: "1" } },
      });
      loadingSeconds += (performance.now() - loadStart) / 1000;
      if (name === "decoder") {
        const warmStart = performance.now();
        const resourceStart = resourceSeconds;
        await this.codecParity(asset);
        await this.tryCapture(asset);
        codecWarmupSeconds +=
          (performance.now() - warmStart) / 1000 -
          (resourceSeconds - resourceStart);
      }
    }
    this.emit({
      type: "progress",
      loadSeconds: loadingSeconds,
      cacheMode: "GPU resident dynamic KV",
      graphCapture: Boolean(this.capturedDecoder),
    });
    this.emit({
      type: "status",
      phase: "warming",
      message: "校验三种声音的官方前处理、MROPE 与首步 logits",
    });
    const warm = performance.now();
    const resourceBeforeWarm = resourceSeconds;
    await this.prefillParity(asset);
    await this.tryCapturePredictor(asset);
    await this.tryCaptureTalker(asset);
    this.emit({
      type: "progress",
      warmupSeconds:
        codecWarmupSeconds +
        (performance.now() - warm) / 1000 -
        (resourceSeconds - resourceBeforeWarm),
      resourceReadSeconds: resourceSeconds,
      prepareWallSeconds: (performance.now() - prepareStarted) / 1000,
    });
    const device = this.device as { lost: Promise<{ message: string }> };
    device.lost.then((info) => {
      if (this.device !== device) return;
      this.cancel();
      this.emit({ type: "error", message: "WebGPU 设备丢失：" + info.message });
    });
    this.emit({
      type: "ready",
      device: "WebGPU · 浏览器本机",
      dtype: "FP16 generator + FP32 stability operations / FP32 decoder",
      quality: "待人工对照",
    });
  }
  private async codecParity(asset: Asset) {
    const input = new ort.Tensor(
      "int32",
      Int32Array.from(
        new BigInt64Array(await asset("decoder-input.i64")),
        Number,
      ),
      [1, 37, 16],
    );
    const expected = new Float32Array(await asset("decoder-reference.f32"));
    let maxError = 0;
    const times: number[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const tick = performance.now();
        const output = await this.sessions.decoder.run({ audio_codes: input });
        try {
          const pcm = (await output.waveform.getData()) as Float32Array;
          times.push((performance.now() - tick) / 1000);
          if (pcm.length !== expected.length)
            throw Error("WebGPU 解码长度与 CPU 参考不一致");
          for (let j = 0; j < pcm.length; j++) {
            if (!Number.isFinite(pcm[j]))
              throw Error("WebGPU 解码器输出非有限数值");
            maxError = Math.max(maxError, Math.abs(pcm[j] - expected[j]));
          }
        } finally {
          release(output);
        }
      }
    } finally {
      input.dispose();
    }
    this.emit({
      type: "progress",
      decoderSeconds: times,
      decoderMaxError: maxError,
    });
    if (maxError > 0.005)
      throw Error("WebGPU 解码数值校验失败，最大绝对误差 " + maxError);
  }
  private async tryCapturePredictor(asset: Asset) {
    const candidate = new CapturedPredictor(this.device);
    try {
      this.emit({
        type: "status",
        phase: "warming",
        message: "捕获固定残差预测图并校验三种声音",
      });
      await candidate.prepare(await asset("predictor-step.onnx"));
      const fixtures = JSON.parse(
        new TextDecoder().decode(await asset("prefill-fixtures.json")),
      );
      const times = [];
      for (const fixture of fixtures) {
        const hidden = floatArray(new Uint16Array(await asset(fixture.hidden)));
        const expected = new Float32Array(await asset(fixture.predictor));
        const tick = performance.now();
        const firstEmbedding = await this.embed("codec-embed", [
          fixture.codes[0],
        ]);
        const actual = await candidate.predict(
          hidden,
          fixture.codes,
          undefined,
          firstEmbedding,
        );
        times.push((performance.now() - tick) / 1000);
        let dot = 0,
          a2 = 0,
          b2 = 0;
        for (let i = 0; i < actual.length; i++) {
          if (!Number.isFinite(actual[i])) throw Error("捕获的预测器数值无效");
          dot += actual[i] * expected[i];
          a2 += actual[i] ** 2;
          b2 += expected[i] ** 2;
        }
        if (dot / Math.sqrt(a2 * b2) < 0.999)
          throw Error("捕获的预测器与官方参考不一致");
        await candidate.verifySampler(actual);
      }
      this.capturedPredictor = candidate;
      await this.sessions.predictor.release();
      delete this.sessions.predictor;
      this.emit({
        type: "progress",
        predictorGraphCapture: true,
        capturedPredictorSeconds: times,
      });
    } catch (error) {
      await candidate.release();
      this.emit({
        type: "progress",
        predictorGraphCapture: false,
        predictorGraphCaptureError: String(error),
      });
    }
  }
  private async tryCaptureTalker(asset: Asset) {
    const candidate = new CapturedTalker(this.device);
    let invalidDynamic = false;
    try {
      this.emit({
        type: "status",
        phase: "warming",
        message: "校验主生成器静态 KV 与 GPU 图捕获",
      });
      await candidate.prepare(await asset("talker-step.onnx"));
      const stepFixtures = JSON.parse(
        new TextDecoder().decode(await asset("step-fixtures.json")),
      );
      const fixtures = JSON.parse(
        new TextDecoder().decode(await asset("prefill-fixtures.json")),
      );
      const results = [];
      const failures: string[] = [];
      for (const fixture of fixtures) {
        const formed = await this.prefill(
          fixture.text,
          fixture.language,
          fixture.speaker,
        );
        const empty = Array.from(
          { length: 56 },
          () =>
            new ort.Tensor("float16", new Uint16Array(1024), [1, 8, 1, 128]),
        );
        const initial = await this.talker(formed.embeds, 0, empty).finally(() =>
          empty.forEach((t) => t.dispose()),
        );
        let expected:
          | Awaited<ReturnType<QwenBrowserPipeline["talker"]>>
          | undefined;
        try {
          candidate.seed(initial.past);
          const position = formed.embeds.length / H;
          const codecIds = i32(fixture.codes, [1, 16]);
          const embedded = await this.sessions.residual.run({
            codes: codecIds,
          });
          const nextInput = formed.pad.slice();
          try {
            const values = floatArray(
              (await embedded.embeds.getData()) as Uint16Array,
            );
            for (let i = 0; i < H; i++) nextInput[i] += values[i];
          } finally {
            codecIds.dispose();
            release(embedded);
          }
          expected = await this.talker(nextInput, position, initial.past);
          const tick = performance.now();
          const actual = await candidate.run(nextInput, position);
          const seconds = (performance.now() - tick) / 1000;
          const reference = stepFixtures.find(
            (f: { speaker: string }) => f.speaker === fixture.speaker,
          );
          const official = new Float32Array(await asset(reference.file));
          const compareOfficial = (values: Float32Array) => {
            let dot = 0,
              a2 = 0,
              b2 = 0,
              top1 = 0;
            for (let i = 0; i < values.length; i++) {
              if (!Number.isFinite(values[i]) || !Number.isFinite(official[i]))
                throw Error("下一步数值包含非有限值");
              dot += values[i] * official[i];
              a2 += values[i] ** 2;
              b2 += official[i] ** 2;
              if (values[i] > values[top1]) top1 = i;
            }
            return { cosine: dot / Math.sqrt(a2 * b2), top1 };
          };
          const staticOfficial = compareOfficial(actual.logits),
            dynamicOfficial = compareOfficial(expected.logits);
          let dot = 0,
            a2 = 0,
            b2 = 0,
            maxError = 0;
          for (let i = 0; i < actual.logits.length; i++) {
            const a = actual.logits[i],
              b = expected.logits[i];
            if (!Number.isFinite(a) || !Number.isFinite(b))
              throw Error("静态生成器非有限数值");
            dot += a * b;
            a2 += a * a;
            b2 += b * b;
            maxError = Math.max(maxError, Math.abs(a - b));
          }
          const cosine = dot / Math.sqrt(a2 * b2);
          results.push({
            speaker: fixture.speaker,
            seconds,
            cosine,
            maxError,
            staticOfficial,
            dynamicOfficial,
            officialTop1: reference.top1,
          });
          this.emit({ type: "progress", staticTalkerParity: results });
          // Both approximate FP16 executions are judged against an independent
          // official FP32 next-step reference, using the same gate as prefill.
          if (
            dynamicOfficial.cosine < 0.999 ||
            dynamicOfficial.top1 !== reference.top1
          ) {
            invalidDynamic = true;
            failures.push("动态生成器未通过官方下一步对照：" + fixture.speaker);
          }
          if (
            staticOfficial.cosine < 0.999 ||
            staticOfficial.top1 !== reference.top1
          )
            failures.push("静态生成器未通过官方下一步对照：" + fixture.speaker);
        } finally {
          initial.past.forEach((t) => t.dispose());
          expected?.past.forEach((t) => t.dispose());
        }
      }
      if (failures.length) throw Error(failures.join("；"));
      this.capturedTalker = candidate;
      this.emit({
        type: "progress",
        talkerGraphCapture: true,
        staticTalkerParity: results,
      });
    } catch (error) {
      await candidate.release();
      if (invalidDynamic) throw error;
      this.emit({
        type: "progress",
        talkerGraphCapture: false,
        talkerGraphCaptureError: String(error),
      });
    }
  }
  private async prefillParity(asset: Asset) {
    const fixtures = JSON.parse(
      new TextDecoder().decode(await asset("prefill-fixtures.json")),
    );
    const results = [];
    const failures: string[] = [];
    for (const fixture of fixtures) {
      const formed = await this.prefill(
        fixture.text,
        fixture.language,
        fixture.speaker,
      );
      const expectedInput = floatArray(
        new Uint16Array(await asset(fixture.input)),
      );
      if (formed.embeds.length !== expectedInput.length)
        throw Error("官方前处理长度不一致：" + fixture.speaker);
      // Compare the actual FP16 tensor sent to the model. The temporary JS sum
      // is FP32; comparing it before rounding would test the wrong input.
      const roundedInput = floatArray(halfArray(formed.embeds));
      let inputError = 0,
        squaredError = 0,
        referenceSquared = 0,
        inputDot = 0,
        actualSquared = 0;
      for (let i = 0; i < expectedInput.length; i++) {
        if (!Number.isFinite(roundedInput[i]))
          throw Error("前处理输出非有限数值");
        inputError = Math.max(
          inputError,
          Math.abs(roundedInput[i] - expectedInput[i]),
        );
        squaredError += (roundedInput[i] - expectedInput[i]) ** 2;
        referenceSquared += expectedInput[i] ** 2;
        actualSquared += roundedInput[i] ** 2;
        inputDot += roundedInput[i] * expectedInput[i];
      }
      const inputRelativeRms = Math.sqrt(squaredError / referenceSquared);
      const inputCosine =
        inputDot / Math.sqrt(referenceSquared * actualSquared);
      this.emit({
        type: "progress",
        inputParity: {
          speaker: fixture.speaker,
          inputError,
          inputRelativeRms,
          inputCosine,
        },
      });
      // FP16 spacing above magnitude 8 already exceeds .005. Use a scale-aware
      // gate as well as an absolute ceiling; logits must also pass independently.
      if (
        inputError > 0.025 ||
        inputRelativeRms > 0.0025 ||
        inputCosine < 0.99999
      )
        failures.push(
          `前处理 ${fixture.speaker}: max=${inputError}, relativeRMS=${inputRelativeRms}`,
        );
      const empty: Tensor[] = Array.from(
        { length: 56 },
        () =>
          new ort.Tensor("float16", new Uint16Array(8 * 128), [1, 8, 1, 128]),
      );
      const actual = await this.talker(formed.embeds, 0, empty).finally(() =>
        empty.forEach((t) => t.dispose()),
      );
      actual.past.forEach((t) => t.dispose());
      const expected = floatArray(new Uint16Array(await asset(fixture.logits)));
      let dot = 0,
        a2 = 0,
        b2 = 0,
        maxError = 0,
        top = 0;
      for (let i = 0; i < expected.length; i++) {
        const a = actual.logits[i],
          b = expected[i];
        if (!Number.isFinite(a)) throw Error("FP16 生成器输出非有限值");
        dot += a * b;
        a2 += a * a;
        b2 += b * b;
        maxError = Math.max(maxError, Math.abs(a - b));
        if (a > actual.logits[top]) top = i;
      }
      const cosine = dot / Math.sqrt(a2 * b2);
      results.push({
        speaker: fixture.speaker,
        inputError,
        inputRelativeRms,
        inputCosine,
        maxError,
        cosine,
        top1: top,
        expectedTop1: fixture.top1,
      });
      this.emit({ type: "progress", prefillParity: results });
      if (cosine < 0.999 || top !== fixture.top1)
        failures.push(
          `生成器官方对照失败 ${fixture.speaker}: cosine=${cosine}, top1=${top}/${fixture.top1}`,
        );
      const h = new ort.Tensor(
        "float16",
        new Uint16Array(await asset(fixture.hidden)),
        [1, H],
      );
      const ids = i32(fixture.codes, [1, 16]);
      const predicted = await this.sessions.predictor.run({
        hidden: h,
        codes: ids,
      });
      try {
        const got = floatArray(
          (await predicted.logits.getData()) as Uint16Array,
        );
        const want = new Float32Array(await asset(fixture.predictor));
        let dot = 0,
          g2 = 0,
          w2 = 0;
        for (let i = 0; i < want.length; i++) {
          if (!Number.isFinite(want[i]))
            throw Error("官方预测器参考包含非有限值");
          if (!Number.isFinite(got[i])) throw Error("残差预测器非有限值");
          dot += got[i] * want[i];
          g2 += got[i] * got[i];
          w2 += want[i] * want[i];
        }
        const similarity = dot / Math.sqrt(g2 * w2);
        this.emit({
          type: "progress",
          predictorParity: { speaker: fixture.speaker, cosine: similarity },
        });
        if (similarity < 0.999)
          failures.push("残差预测器官方对照失败：" + similarity);
      } finally {
        h.dispose();
        ids.dispose();
        release(predicted);
      }
    }
    if (failures.length)
      throw Error("数值校验未通过，禁止进入试听：" + failures.join("；"));
  }
  private async tryCapture(asset: Asset) {
    const candidate = new CapturedDecoder(this.device);
    try {
      this.emit({
        type: "status",
        phase: "warming",
        message: "尝试固定解码图捕获与预分配 GPU 缓冲",
      });
      await candidate.prepare(await asset("decoder.onnx"));
      const codes = Int32Array.from(
          new BigInt64Array(await asset("decoder-input.i64")),
          Number,
        ),
        expected = new Float32Array(await asset("decoder-reference.f32"));
      const times = [];
      for (let i = 0; i < 3; i++) {
        const tick = performance.now(),
          pcm = await candidate.decode(codes);
        times.push((performance.now() - tick) / 1000);
        let error = 0;
        for (let j = 0; j < pcm.length; j++)
          error = Math.max(error, Math.abs(pcm[j] - expected[j]));
        if (!Number.isFinite(error) || error > 0.005)
          throw Error("捕获图数值不一致：" + error);
      }
      this.capturedDecoder = candidate;
      await this.sessions.decoder.release();
      delete this.sessions.decoder;
      this.emit({
        type: "progress",
        graphCapture: true,
        capturedDecoderSeconds: times,
      });
    } catch (error) {
      await candidate.release();
      this.emit({
        type: "progress",
        graphCapture: false,
        graphCaptureError: String(error),
      });
    }
  }
  flow(runId: string, played: number) {
    if (runId === this.currentId) this.played = Math.max(this.played, played);
  }
  cancel() {
    this.version++;
  }
  simulateDeviceLoss() {
    (this.device as { destroy(): void } | undefined)?.destroy();
  }
  start(request: RequestSpec) {
    const token = ++this.version;
    this.serial = this.serial
      .catch(() => {})
      .then(() => this.generate(request, token))
      .catch((error) => {
        this.emit({
          type: "diagnostic",
          message: error instanceof Error ? error.stack : String(error),
        });
        this.emit({
          type: "error",
          runId: request.runId,
          message: String(error),
        });
      });
  }
  async release() {
    this.cancel();
    await this.serial.catch(() => {});
    await this.capturedDecoder?.release();
    this.capturedDecoder = undefined;
    await this.capturedPredictor?.release();
    this.capturedPredictor = undefined;
    await this.capturedTalker?.release();
    this.capturedTalker = undefined;
    for (const session of Object.values(this.sessions)) await session.release();
    this.sessions = {};
    (this.device as { destroy(): void } | undefined)?.destroy();
    this.device = undefined;
  }
  private async embed(name: string, ids: number[]) {
    const input = i64(ids, [1, ids.length]);
    const output = await this.sessions[name].run({
      [name === "text-embed" ? "text_ids" : "codec_ids"]: input,
    });
    try {
      return floatArray((await output.embeds.getData()) as Uint16Array);
    } finally {
      input.dispose();
      release(output);
    }
  }
  private async prefill(text: string, language: string, speaker: string) {
    const c = this.cfg,
      tc = c.talker_config;
    const ids = this.tokenizer.encode(
      `<|im_start|>assistant\n${text}<|im_end|>\n<|im_start|>assistant\n`,
    ).ids;
    const spec = await this.embed("text-embed", [
      c.tts_bos_token_id,
      c.tts_eos_token_id,
      c.tts_pad_token_id,
    ]);
    const bos = spec.slice(0, H),
      eos = spec.slice(H, H * 2),
      pad = spec.slice(H * 2);
    const tags = [
      tc.codec_think_id,
      tc.codec_think_bos_id,
      tc.codec_language_id[language.toLowerCase()],
      tc.codec_think_eos_id,
      tc.spk_id[speaker.toLowerCase()],
      tc.codec_pad_id,
      tc.codec_bos_id,
    ];
    if (tags.some((v) => typeof v !== "number"))
      throw Error("语言或声音映射缺失");
    const codec = await this.embed("codec-embed", tags),
      role = await this.embed("text-embed", ids.slice(0, 3));
    const body = await this.embed("text-embed", ids.slice(3, -5));
    const padCodec = await this.embed("codec-embed", [tc.codec_pad_id]);
    const out = new Float32Array(
      role.length + (tags.length - 1) * H + body.length + H * 2,
    );
    out.set(role);
    let offset = role.length;
    for (let i = 0; i < tags.length - 1; i++) {
      const base = i === tags.length - 2 ? bos : pad;
      for (let j = 0; j < H; j++) out[offset + j] = base[j] + codec[i * H + j];
      offset += H;
    }
    for (let i = 0; i < body.length; i++)
      out[offset + i] = body[i] + padCodec[i % H];
    offset += body.length;
    for (let j = 0; j < H; j++) out[offset + j] = eos[j] + padCodec[j];
    offset += H;
    for (let j = 0; j < H; j++)
      out[offset + j] = pad[j] + codec[(tags.length - 1) * H + j];
    return { embeds: out, pad };
  }
  private async talker(embeds: Float32Array, position: number, past: Tensor[]) {
    const cur = embeds.length / H,
      seen = Number(past[0].dims[2]),
      total = seen + cur;
    const mask = new Float32Array(cur * total);
    for (let row = 0; row < cur; row++)
      for (let col = 0; col < total; col++)
        if (col === 0 || col > seen + row) mask[row * total + col] = -65504;
    const positions = Array.from(
      { length: cur * 3 },
      (_, i) => position + (i % cur),
    );
    const inputs: Record<string, Tensor> = {
      embeds: fp16(embeds, [1, cur, H]),
      positions: new ort.Tensor("int32", Int32Array.from(positions), [
        3,
        1,
        cur,
      ]),
      mask: fp16(mask, [1, 1, cur, total]),
    };
    past.forEach((p, i) => (inputs["past_" + i] = p));
    // Own prefill outputs explicitly. ORT's implicit GPU output handles can be
    // recycled after tensor.dispose() and fail on the next request in 1.30.0.
    const fetches: Record<string, Tensor | null> = {
      logits: null,
      hidden: null,
    };
    for (let i = 0; i < 56; i++) {
      const buffer = (this.device as any).createBuffer({
        size: 8 * total * 128 * 2,
        usage: 128 | 8 | 4,
      });
      fetches["present_" + i] = ort.Tensor.fromGpuBuffer(buffer, {
        dataType: "float16",
        dims: [1, 8, total, 128],
        dispose: () => buffer.destroy(),
      });
    }
    let output: Record<string, Tensor>;
    try {
      output = await this.sessions["talker-cache"].run(inputs, fetches);
    } catch (error) {
      Object.values(fetches).forEach((t) => t?.dispose());
      throw error;
    } finally {
      inputs.embeds.dispose();
      inputs.positions.dispose();
      inputs.mask.dispose();
    }
    const next = Array.from({ length: 56 }, (_, i) => output["present_" + i]);
    try {
      return {
        logits: floatArray(
          (await output.logits.getData()) as Uint16Array,
        ).slice(-this.cfg.talker_config.vocab_size),
        hidden: floatArray(
          (await output.hidden.getData()) as Uint16Array,
        ).slice(-H),
        past: next,
      };
    } catch (error) {
      next.forEach((t) => t.dispose());
      throw error;
    } finally {
      output.logits.dispose();
      output.hidden.dispose();
    }
  }
  private async residual(
    hidden: Float32Array,
    first: number,
    random: () => number,
    token: number,
  ) {
    const codes = Array(16).fill(0);
    codes[0] = first;
    const h = fp16(hidden, [1, H]);
    const firstEmbedding = this.capturedPredictor
      ? await this.embed("codec-embed", [first])
      : new Float32Array();
    try {
      if (this.capturedPredictor)
        return await this.capturedPredictor.generateFrame(
          hidden,
          firstEmbedding,
          first,
          random,
          () => token !== this.version,
        );
      for (let group = 1; group < 16; group++) {
        if (token !== this.version) return null;
        const ids = i32(codes, [1, 16]);
        const output = await this.sessions.predictor.run({
          hidden: h,
          codes: ids,
        });
        try {
          const all = floatArray(
            (await output.logits.getData()) as Uint16Array,
          );
          const vocab = all.length / 15;
          codes[group] = sampleLogits(
            all.slice((group - 1) * vocab, group * vocab),
            random,
          );
        } finally {
          ids.dispose();
          release(output);
        }
      }
    } finally {
      h.dispose();
    }
    return codes;
  }
  private async decode(codes: number[][], newFrames: number) {
    const window = codes.slice(-(25 + newFrames));
    if (
      window.some((frame) =>
        frame.some(
          (code) => !Number.isInteger(code) || code < 0 || code >= 2048,
        ),
      )
    )
      throw Error("解码器收到无效 codec ID");
    const context = window.length - newFrames;
    // Causal decoder: padding on the right cannot affect earlier samples. Always
    // retain up to 25 real context frames and crop exactly 1920 samples per frame.
    const real = window.length;
    while (window.length < 37) window.push(window[window.length - 1]);
    if (this.capturedDecoder)
      return (
        await this.capturedDecoder.decode(Int32Array.from(window.flat()))
      ).slice(context * 1920, real * 1920);
    const input = new ort.Tensor(
      "int32",
      Int32Array.from(window.flat()),
      [1, 37, 16],
    );
    const output = await this.sessions.decoder.run({ audio_codes: input });
    try {
      return ((await output.waveform.getData()) as Float32Array).slice(
        context * 1920,
        real * 1920,
      );
    } finally {
      input.dispose();
      release(output);
    }
  }
  private async generate(request: RequestSpec, token: number) {
    if (token !== this.version) return;
    this.currentId = request.runId;
    this.played = 0;
    const started = performance.now();
    let seq = 0,
      generated = 0,
      waiting = 0;
    const stages = { talkerSeconds: 0, predictorSeconds: 0, decoderSeconds: 0 };
    const send = (data: Record<string, unknown>, transfer?: Transferable[]) =>
      this.emit({ ...data, runId: request.runId }, transfer);
    for (
      let part = 0;
      part < request.segments.length && token === this.version;
      part++
    ) {
      const random = seeded(42 + part),
        prepared = await this.prefill(
          request.segments[part],
          request.language,
          request.speaker,
        );
      let past: Tensor[] = Array.from(
        { length: 56 },
        () =>
          new ort.Tensor("float16", new Uint16Array(8 * 128), [1, 8, 1, 128]),
      );
      let current = prepared.embeds,
        position = 0;
      const history: number[] = [],
        codes: number[][] = [];
      let pending = 0,
        ended = false;
      try {
        for (let step = 0; step < 1800 && token === this.version; step++) {
          const pause = performance.now();
          while (generated - this.played >= 29 && token === this.version)
            await new Promise((r) => setTimeout(r, 50));
          waiting += (performance.now() - pause) / 1000;
          if (token !== this.version) break;
          const talkerStart = performance.now();
          let out: { logits: Float32Array; hidden: Float32Array };
          if (step && this.capturedTalker) {
            out = await this.capturedTalker.run(current, position);
          } else {
            const previous = past;
            const dynamic = await this.talker(current, position, past);
            past = dynamic.past;
            previous.forEach((t) => t.dispose());
            if (this.capturedTalker) this.capturedTalker.seed(past);
            out = dynamic;
          }
          stages.talkerSeconds += (performance.now() - talkerStart) / 1000;
          position += current.length / H;
          const first = sampleLogits(
            out.logits,
            random,
            history,
            this.cfg.talker_config.codec_eos_token_id,
            2,
          );
          if (first === this.cfg.talker_config.codec_eos_token_id) {
            ended = true;
            break;
          }
          history.push(first);
          const predictorStart = performance.now();
          const frame = await this.residual(out.hidden, first, random, token);
          stages.predictorSeconds +=
            (performance.now() - predictorStart) / 1000;
          if (!frame) break;
          codes.push(frame);
          pending++;
          if (pending === request.frames) {
            const decoderStart = performance.now();
            const pcm = await this.decode(codes, pending);
            stages.decoderSeconds += (performance.now() - decoderStart) / 1000;
            pending = 0;
            generated += pcm.length / 24000;
            const active = (performance.now() - started) / 1000 - waiting;
            send(
              {
                type: "audio",
                seq: seq++,
                part,
                sampleRate: 24000,
                pcm,
                generationSeconds: active,
                rtf: active / generated,
                backpressureSeconds: waiting,
                stages: { ...stages },
              },
              [pcm.buffer],
            );
            if (codes.length > 37) codes.splice(0, codes.length - 37);
          }
          const ids = i32(frame, [1, 16]);
          const embedded = await this.sessions.residual.run({ codes: ids });
          try {
            current = floatArray(
              (await embedded.embeds.getData()) as Uint16Array,
            );
            for (let i = 0; i < H; i++) current[i] += prepared.pad[i];
          } finally {
            ids.dispose();
            release(embedded);
          }
        }
        if (token !== this.version) break;
        if (!ended)
          throw Error("WebGPU 片段触及生成上限，可能截断；不标为完成");
        if (pending) {
          const pcm = await this.decode(codes, pending);
          generated += pcm.length / 24000;
          send({ type: "audio", seq: seq++, part, sampleRate: 24000, pcm }, [
            pcm.buffer,
          ]);
        }
        send({ type: "part", part, text: request.segments[part] });
      } finally {
        past.forEach((t) => t.dispose());
      }
    }
    const elapsed = (performance.now() - started) / 1000;
    send({
      type: token === this.version ? "done" : "cancelled",
      generationSeconds: elapsed - waiting,
      wallSeconds: elapsed,
      backpressureSeconds: waiting,
      audioSeconds: generated,
      rtf: generated ? (elapsed - waiting) / generated : null,
      stages,
    });
  }
}
