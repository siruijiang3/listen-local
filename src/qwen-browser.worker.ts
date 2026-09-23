/// <reference lib="webworker" />
import * as ort from "qwen-ort/webgpu";
import { QwenBrowserPipeline } from "./qwen-browser-pipeline";
const scope = self as unknown as DedicatedWorkerGlobalScope;
ort.env.wasm.wasmPaths = "/runtime/ort-qwen/1.30.0/";
ort.env.wasm.numThreads = 1;
ort.env.webgpu.powerPreference = "high-performance";
ort.env.logLevel = "warning";
const emit = (data: Record<string, unknown>, transfer: Transferable[] = []) =>
  scope.postMessage(data, transfer);
for (const method of ["log", "warn", "error", "info"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (
      /CPU|not support|unsupported|assigned|GetCapability|VerifyEachNode/i.test(
        message,
      )
    )
      emit({ type: "diagnostic", message });
    original(...args);
  };
}
let cancelled = false;
let downloaded = 0;
let downloadSeconds = 0;
let cachedBytes = 0;
let pipeline: QwenBrowserPipeline | undefined;
async function asset(
  path: string,
  version: string,
  expectedBytes?: number,
  expectedHash?: string,
) {
  const cache = await caches.open("qwen-webgpu-" + version);
  const saved = await cache.match(path);
  if (saved) {
    const data = await saved.arrayBuffer();
    cachedBytes += data.byteLength;
    emit({
      type: "progress",
      cached: true,
      downloadBytes: downloaded,
      cachedBytes,
      message: "读取版本缓存",
    });
    return data;
  }
  // Reuse unchanged verified files across manifest versions. Updating one graph
  // must not force another transfer of every embedding and decoder weight.
  if (expectedHash) {
    const versions = (await caches.keys())
      .filter(
        (name) =>
          name.startsWith("qwen-webgpu-") &&
          name !== "qwen-webgpu-index-v1" &&
          name !== "qwen-webgpu-" + version,
      )
      .reverse();
    for (const name of versions) {
      if (cancelled) throw Error("已取消下载");
      const existing = await (await caches.open(name)).match(path);
      if (!existing) continue;
      const blob = await existing.blob();
      if (blob.size !== expectedBytes) continue;
      const bytes = await blob.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== expectedHash) continue;
      await cache.put(path, new Response(blob));
      cachedBytes += bytes.byteLength;
      emit({
        type: "progress",
        cached: true,
        cachedBytes,
        downloadBytes: downloaded,
        reusedVersion: name,
      });
      return bytes;
    }
  }
  const start = performance.now();
  const response = await fetch(path);
  if (!response.ok) throw Error(`资源下载失败 ${response.status}: ${path}`);
  const stream = response.body!.getReader();
  let loaded = 0;
  let reported = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await stream.read();
    if (r.done) break;
    if (cancelled) {
      await stream.cancel();
      throw Error("已取消下载");
    }
    chunks.push(r.value);
    loaded += r.value.length;
    if (performance.now() - reported >= 100) {
      emit({
        type: "progress",
        cached: false,
        downloadBytes: downloaded + loaded,
        totalBytes: expectedBytes,
        downloadSeconds: downloadSeconds + (performance.now() - start) / 1000,
      });
      reported = performance.now();
    }
  }
  if (expectedBytes && loaded !== expectedBytes)
    throw Error("模型资源长度不符");
  const blob = new Blob(chunks as BlobPart[]);
  chunks.length = 0;
  downloaded += loaded;
  downloadSeconds += (performance.now() - start) / 1000;
  emit({
    type: "progress",
    downloadBytes: downloaded,
    downloadSeconds,
    cached: false,
  });
  await cache.put(path, new Response(blob));
  return blob.arrayBuffer();
}
scope.onmessage = async ({ data: message }) => {
  if (message.type === "diagnose-device-loss") {
    pipeline?.simulateDeviceLoss();
    return;
  }
  if (message.type === "cancel") {
    cancelled = true;
    pipeline?.cancel();
    return;
  }
  if (message.type === "flow") {
    pipeline?.flow(message.runId, message.playedSeconds);
    return;
  }
  if (message.type === "start") {
    pipeline?.start(message);
    return;
  }
  if (message.type !== "prepare") return;
  cancelled = false;
  downloaded = 0;
  downloadSeconds = 0;
  cachedBytes = 0;
  try {
    emit({
      type: "status",
      phase: "loading",
      message: "WebGPU：验证官方权重导出的 FP32 音频解码器",
    });
    if (!("gpu" in navigator))
      throw Error("该浏览器未提供 WebGPU，请使用独立 Chrome / Edge。");
    const index = await caches.open("qwen-webgpu-index-v1");
    const manifestUrl = "/models/qwen-webgpu/manifest.json";
    let response: Response | undefined;
    try {
      response = await fetch(manifestUrl, { cache: "no-store" });
      if (!response.ok) throw Error("manifest HTTP " + response.status);
      await index.put(manifestUrl, response.clone());
    } catch {
      response = await index.match(manifestUrl);
    }
    if (
      !response ||
      !(response.headers.get("content-type") ?? "").includes("json")
    )
      throw Error("WebGPU 导出尚未就绪；此模式未连接本地推理服务。");
    const manifest = await response.json();
    emit({ type: "progress", ...manifest });
    pipeline = new QwenBrowserPipeline(emit);
    await pipeline.prepare(async (name) => {
      const file = manifest.files.find(
        (f: { file: string }) => f.file === name,
      );
      if (!file) throw Error("导出 manifest 缺少 " + name);
      const data = await asset(
        "/models/qwen-webgpu/" + name,
        manifest.version,
        file.bytes,
        file.sha256,
      );
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== file.sha256) {
        await (
          await caches.open("qwen-webgpu-" + manifest.version)
        ).delete("/models/qwen-webgpu/" + name);
        throw Error("资源 SHA-256 不匹配，已丢弃损坏缓存：" + name);
      }
      return data;
    });
  } catch (error) {
    await pipeline?.release();
    pipeline = undefined;
    emit({ type: "error", message: String(error), route: "browser" });
  }
};
