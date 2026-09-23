import { useState } from "react";

type SavedRecord = {
  runId: string;
  createdAt?: string;
  engine?: string;
  completion?: string;
  received?: number;
  request?: { speaker?: string; frames?: number };
  [key: string]: unknown;
};

// Read only this application's OPFS records. No model preparation or playback.
export function SavedMeasurements() {
  const [records, setRecords] = useState<SavedRecord[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const record = records.find((r) => r.runId === selected);
  async function read() {
    setBusy(true);
    setStatus("");
    try {
      const root = await navigator.storage.getDirectory();
      const sessions = (await root.getDirectoryHandle(
        "qwen-realtime-v1",
      )) as FileSystemDirectoryHandle & {
        values(): AsyncIterableIterator<FileSystemHandle>;
      };
      const saved: SavedRecord[] = [];
      let incomplete = 0;
      for await (const entry of sessions.values()) {
        if (entry.kind !== "directory") continue;
        try {
          const file = await (
            await (entry as FileSystemDirectoryHandle).getFileHandle(
              "measurement.json",
            )
          ).getFile();
          const item = JSON.parse(await file.text()) as SavedRecord;
          if (item.runId === entry.name) saved.push(item);
        } catch {
          incomplete++;
        }
      }
      saved.sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      );
      setRecords(saved);
      setSelected(saved.at(-1)?.runId ?? "");
      setStatus(
        `找到 ${saved.length} 条测量记录；${incomplete} 个任务尚无完成记录。`,
      );
    } catch (e) {
      setStatus(
        e instanceof DOMException && e.name === "NotFoundError"
          ? "尚无已保存的测量记录。"
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rt-panel rt-tests">
      <h2>本机测量记录</h2>
      <p>
        从本网站的 OPFS
        读取已保存记录，刷新后仍可查看。不会启动模型或恢复生成；浏览器清理站点数据后记录也会移除。
      </p>
      <button disabled={busy} onClick={() => void read()}>
        {busy ? "读取中…" : "读取已保存测量"}
      </button>
      <p role="status">{status}</p>
      {records.length > 0 && (
        <>
          <label>
            已保存测量
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {records.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.createdAt} · {r.engine} · {r.request?.speaker} ·{" "}
                  {r.request?.frames} 帧 · {(r.received ?? 0).toFixed(2)} s
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setShowJson(!showJson)}>
            {showJson ? "收起测量 JSON" : "查看测量 JSON"}
          </button>
          {showJson && (
            <textarea
              aria-label="已保存测量 JSON"
              rows={12}
              readOnly
              value={JSON.stringify(record, null, 2)}
            />
          )}
        </>
      )}
    </section>
  );
}
