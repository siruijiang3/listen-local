import { invoke } from "@tauri-apps/api/core";

export interface Connection {
  protocol: number;
  port: number;
  token: string;
}
let connection: Connection | undefined;
export async function connect() {
  const query = new URLSearchParams(location.search);
  connection =
    import.meta.env.DEV && query.has("port")
      ? {
          protocol: 1,
          port: Number(query.get("port")),
          token: query.get("token") || "",
        }
      : await invoke<Connection>("connection");
  if (connection.protocol !== 1)
    throw new Error("客户端与本地服务版本不一致。");
}
export async function request<T = unknown>(
  action: string,
  body?: unknown,
): Promise<T> {
  if (!connection) throw new Error("本地服务尚未连接。");
  const result = await fetch(
    `http://127.0.0.1:${connection.port}/v1/${action}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!result.ok) {
    const error = await result
      .json()
      .catch(() => ({ error: `本地服务错误 (${result.status})` }));
    throw new Error(error.error || "操作失败。");
  }
  return result.json() as Promise<T>;
}
export async function audio(job: string, offset: number, count: number) {
  if (!connection) throw new Error("本地服务尚未连接。");
  const result = await fetch(
    `http://127.0.0.1:${connection.port}/v1/audio?job=${encodeURIComponent(job)}&offset=${offset}&count=${count}`,
    {
      headers: { Authorization: `Bearer ${connection.token}` },
    },
  );
  if (!result.ok) throw new Error("无法读取音频。");
  return result.arrayBuffer();
}

export interface Chapter {
  title: string;
  text: string;
}
export interface Book {
  id: string;
  title: string;
  created: number;
}
export interface Artifact {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
}
export interface Job {
  id: string;
  book_id: string;
  title: string;
  speaker: string;
  device: string;
  actual_device?: string;
  mode: "live" | "after";
  status: string;
  error?: string;
  samples: number;
  played: number;
  completed: number;
  total: number;
  rtf?: number;
  generation_seconds: number;
  exports: Artifact[];
}
export interface Settings {
  library: string;
  runtimePython: string;
  model: string;
  threads: number;
}
export interface State {
  books: Book[];
  jobs: Job[];
  settings: Settings;
  active?: string;
  engine?: {
    device: string;
    streaming: boolean;
    reason?: string;
    loadSeconds: number;
  };
  setup?: {
    running: boolean;
    message: string;
    bytes: number;
    total: number;
    error?: boolean;
  };
  share?: { url: string; qr: string };
}
