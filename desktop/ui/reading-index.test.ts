import { describe, expect, it } from "vitest";
import { audibleSegments, segmentAt } from "./reading-index";
import type { ReaderSegment } from "./api";

describe("bidirectional source/audio intervals", () => {
  const segments = [
    { id: "a", sampleStart: 0, sampleEnd: 24 },
    { id: "whitespace", sampleStart: 24, sampleEnd: 24 },
    { id: "b", sampleStart: 24, sampleEnd: 60 },
    { id: "pending", sampleStart: null, sampleEnd: null },
  ] as ReaderSegment[];
  const audible = audibleSegments(segments);
  it("selects the next spoken fragment at a boundary, and retains the ending", () => {
    expect(segmentAt(audible, 0)?.id).toBe("a");
    expect(segmentAt(audible, 23)?.id).toBe("a");
    expect(segmentAt(audible, 24)?.id).toBe("b");
    expect(segmentAt(audible, 60)?.id).toBe("b");
    expect(segmentAt([], 0)).toBeUndefined();
  });
  it("round trips every clickable segment start", () => {
    for (const segment of audible)
      expect(segmentAt(audible, segment.sampleStart!)?.id).toBe(segment.id);
  });
});
