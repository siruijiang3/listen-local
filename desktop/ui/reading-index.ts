import { useEffect, useRef, useState } from "react";
import { request, type Job, type ReaderIndex, type ReaderSegment } from "./api";

export function audibleSegments(segments: ReaderSegment[]) {
  return segments.filter(
    (s) =>
      s.sampleStart !== null &&
      s.sampleEnd !== null &&
      s.sampleEnd > s.sampleStart,
  );
}

// Half-open audio intervals. At the very end keep the final spoken fragment.
export function segmentAt(segments: ReaderSegment[], sample: number) {
  let low = 0,
    high = segments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segments[mid].sampleEnd! <= sample) low = mid + 1;
    else high = mid;
  }
  return segments[Math.min(low, segments.length - 1)];
}

export function useReaderIndex(
  job: Job | undefined,
  fail: (error: unknown) => void,
) {
  const cache = useRef<ReaderIndex | undefined>(undefined);
  const [index, setIndex] = useState<ReaderIndex>();
  useEffect(() => {
    let cancelled = false;
    if (!job) {
      cache.current = undefined;
      setIndex(undefined);
      return;
    }
    const previous =
      cache.current?.job === job.id &&
      Math.abs(cache.current.completed - job.completed) < 9998
        ? cache.current
        : undefined;
    if (!previous) setIndex(undefined);
    const from = previous
      ? Math.max(0, Math.min(previous.completed, job.completed) - 1)
      : 0;
    const query = previous
      ? `&from=${from}&limit=${Math.min(10000, Math.max(previous.completed, job.completed) - from + 2)}`
      : "";
    void request<ReaderIndex>(
      `reader?job=${encodeURIComponent(job.id)}${query}`,
    )
      .then((next) => {
        if (cancelled) return;
        if (previous) {
          const segments = previous.segments.slice();
          for (const segment of next.segments)
            segments[segment.position] = segment;
          // On recovery, discard all timing beyond the new contiguous prefix.
          for (let i = next.completed + 1; i < segments.length; i++) {
            if (
              segments[i].sampleEnd !== null &&
              segments[i].sampleEnd! > next.samples
            )
              segments[i] = {
                ...segments[i],
                sampleStart: null,
                sampleEnd: null,
                status: "pending",
              };
          }
          next = { ...previous, ...next, segments };
        }
        cache.current = next;
        setIndex(next);
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
  }, [job?.id, job?.samples, job?.completed, job?.status, fail]);
  return index?.job === job?.id ? index : undefined;
}
