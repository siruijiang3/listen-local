export type Language = "zh" | "en";
export type EngineId = "kokoro-v1" | "kokoro-zh" | "piper-zh" | "piper-en";
export type Backend = "auto" | "wasm";
export interface Voice {
  id: string;
  label: string;
  language: Language;
}
export interface Candidate {
  id: EngineId;
  name: string;
  subtitle: string;
  repo: string;
  model: string;
  voices: Voice[];
  languages: string;
  frontend: string;
  source: string;
}
export interface Sample {
  id: string;
  language: Language;
  title: string;
  category: string;
  text: string;
  long?: boolean;
}
export interface RunRequest {
  type: "run";
  runId: string;
  engineId: EngineId;
  voiceId: string;
  language: Language;
  text: string;
  backend: Backend;
}
export interface Metrics {
  loadMs: number;
  downloadMs: number;
  synthesisMs: number;
  firstChunkMs: number;
  audioSeconds: number;
  downloadedBytes: number;
  cachedBytes: number;
  backend: string;
  heapStart: number | null;
  heapEnd: number | null;
  heapPeak: number | null;
  chunks: number;
}
export interface AudioChunk {
  blob: Blob;
  seconds: number;
  text: string;
  warnings: string[];
  gainDb: number;
}
export interface Review {
  naturalness: number;
  accuracy: number;
  comfort: number;
  issues: string[];
  note: string;
  preferred: boolean;
}
export interface Run {
  id: string;
  engineId: EngineId;
  voiceId: string;
  language: Language;
  text: string;
  sampleName: string;
  createdAt: string;
  revision: string;
  frontend: string;
  device: string;
  status: "running" | "done" | "cancelled" | "error";
  error?: string;
  metrics?: Metrics;
  chunks: AudioChunk[];
  review: Review;
}
export type WorkerMessage =
  | {
      type: "status";
      label: string;
      file?: string;
      loaded?: number;
      total?: number;
    }
  | { type: "loaded"; backend: string; loadMs: number }
  | {
      type: "chunk";
      pcm: Float32Array;
      sampleRate: number;
      text: string;
      index: number;
      count: number;
      warnings: string[];
      gainDb: number;
      metrics: Metrics;
    }
  | { type: "done"; metrics: Metrics }
  | { type: "error"; message: string };
