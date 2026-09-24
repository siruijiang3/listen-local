import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Player } from "./player";
import { audio } from "./api";
vi.mock("./api", () => ({ audio: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Context {
  static instances: Context[] = [];
  state = "running";
  destination = {};
  ready = deferred<void>();
  closing = deferred<void>();
  audioWorklet = { addModule: vi.fn(() => this.ready.promise) };
  constructor() {
    Context.instances.push(this);
  }
  close() {
    this.state = "closed";
    return this.closing.promise;
  }
  resume = vi.fn(async () => {});
  getOutputTimestamp() {
    return {};
  }
}
class Node {
  static instances: Node[] = [];
  port = {
    onmessage: null as
      | null
      | ((event: { data: Record<string, unknown> }) => void),
    postMessage: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    Node.instances.push(this);
  }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
describe("player session races", () => {
  let player: Player;
  let progress =
    vi.fn<(seconds: number, stalls: number, finished: boolean) => void>();
  let error = vi.fn<(reason: unknown) => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Context.instances = [];
    Node.instances = [];
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("AudioWorkletNode", Node);
    vi.mocked(audio).mockResolvedValue(new ArrayBuffer(48000));
    progress = vi.fn();
    error = vi.fn();
    player = new Player(progress, error);
    player.update(240000, true);
  });
  afterEach(() => {
    void player.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("only the last seek survives delayed module loading and context closing", async () => {
    const first = player.start("book", 0);
    await flush();
    const old = Context.instances[0];
    const second = player.start("book", 3);
    await flush();
    const third = player.start("book", 7, true);
    await flush();
    const latest = Context.instances[1];
    latest.ready.resolve();
    await third;
    old.ready.resolve();
    old.closing.resolve();
    await Promise.all([first, second]);
    expect(Node.instances).toHaveLength(1);
    expect(Node.instances[0].port.postMessage).toHaveBeenCalledWith({
      type: "pause",
      runId: "book",
      value: true,
    });
    expect(audio).toHaveBeenCalledWith(
      "book",
      7 * 48000,
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(error).not.toHaveBeenCalled();
  });
  it("aborts old reads and ignores an already queued old progress message", async () => {
    const read = deferred<ArrayBuffer>();
    vi.mocked(audio).mockReturnValueOnce(read.promise);
    const first = player.start("a", 0);
    await flush();
    Context.instances[0].ready.resolve();
    await first;
    const stale = Node.instances[0].port.onmessage!;
    const signal = vi.mocked(audio).mock.calls[0][3]!;
    const second = player.start("b", 2);
    await flush();
    expect(signal.aborted).toBe(true);
    stale({ data: { type: "progress", playedSeconds: 8, stalls: 0 } });
    read.resolve(new ArrayBuffer(12));
    Context.instances[0].closing.resolve();
    await flush();
    Context.instances[1].ready.resolve();
    await second;
    expect(progress).not.toHaveBeenCalled();
    expect(
      Node.instances[0].port.postMessage.mock.calls.some(
        ([m]) => m.type === "pcm",
      ),
    ).toBe(false);
  });
  it("keeps a pause requested during initialization and holds exact end", async () => {
    const start = player.start("a", 1);
    await flush();
    player.pause("a", true);
    Context.instances[0].ready.resolve();
    await start;
    expect(Node.instances[0].port.postMessage).toHaveBeenCalledWith({
      type: "pause",
      runId: "a",
      value: true,
    });
    const end = player.start("a", 10);
    Context.instances[0].closing.resolve();
    await end;
    expect(progress).toHaveBeenLastCalledWith(10, 0, true);
    expect(Context.instances).toHaveLength(1);
  });
});
