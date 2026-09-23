// ORT publishes named ambient declarations under its canonical package name.
// The Qwen alias uses the same public session/tensor API as the existing runtime.
declare module "qwen-ort/webgpu" {
  export * from "onnxruntime-web/webgpu";
}
