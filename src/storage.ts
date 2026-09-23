import type { Run } from "./types";
let connection: Promise<IDBDatabase> | undefined;
function db() {
  return (connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("listen-lab", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("runs", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function loadRuns(): Promise<Run[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("runs").objectStore("runs").getAll();
    r.onsuccess = () =>
      resolve(
        (r.result as Run[])
          .map(
            (r): Run =>
              r.status === "running"
                ? {
                    ...r,
                    status: "cancelled",
                    error: "上次页面关闭，生成已停止；已完成的片段保留。",
                  }
                : r,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    r.onerror = () => reject(r.error);
  });
}
export async function saveRun(run: Run) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction("runs", "readwrite");
    tx.objectStore("runs").put(run);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function removeRun(id: string) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction("runs", "readwrite");
    tx.objectStore("runs").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
