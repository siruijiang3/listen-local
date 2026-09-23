import * as ort from "qwen-ort/webgpu";
// The decoder has a fixed 37-frame graph. Keep its input/output/staging buffers
// alive and update only the input contents. Explicit readback avoids caching a
// stale CPU copy on a reused output Tensor.
export class CapturedDecoder {
  private session?: ort.InferenceSession;
  private input?: ort.Tensor;
  private output?: ort.Tensor;
  private inputBuffer: any;
  private outputBuffer: any;
  private staging: any;
  private readonly samples = 37 * 1920;
  constructor(private device: any) {}
  async prepare(model: ArrayBuffer) {
    const storage = 128 | 8 | 4; // STORAGE | COPY_DST | COPY_SRC
    this.inputBuffer = this.device.createBuffer({
      size: 37 * 16 * 4,
      usage: storage,
    });
    this.outputBuffer = this.device.createBuffer({
      size: this.samples * 4,
      usage: storage,
    });
    this.staging = this.device.createBuffer({
      size: this.samples * 4,
      usage: 1 | 8,
    }); // MAP_READ | COPY_DST
    this.input = ort.Tensor.fromGpuBuffer(this.inputBuffer, {
      dataType: "int32",
      dims: [1, 37, 16],
    });
    this.output = ort.Tensor.fromGpuBuffer(this.outputBuffer, {
      dataType: "float32",
      dims: [1, 1, this.samples],
    });
    const provider = { name: "webgpu", device: this.device };
    this.session = await ort.InferenceSession.create(model, {
      executionProviders: [provider],
      enableGraphCapture: true,
      preferredOutputLocation: "gpu-buffer",
      extra: { session: { disable_cpu_ep_fallback: "1" } },
    });
  }
  async decode(codes: Int32Array) {
    this.device.queue.writeBuffer(
      this.inputBuffer,
      0,
      codes.buffer,
      codes.byteOffset,
      codes.byteLength,
    );
    await this.session!.run(
      { audio_codes: this.input! },
      { waveform: this.output! },
    );
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      this.outputBuffer,
      0,
      this.staging,
      0,
      this.samples * 4,
    );
    this.device.queue.submit([encoder.finish()]);
    await this.staging.mapAsync(1);
    const pcm = new Float32Array(this.staging.getMappedRange()).slice();
    this.staging.unmap();
    return pcm;
  }
  async release() {
    await this.session?.release();
    this.input?.dispose();
    this.output?.dispose();
    this.inputBuffer?.destroy();
    this.outputBuffer?.destroy();
    this.staging?.destroy();
  }
}
