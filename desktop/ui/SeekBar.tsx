import { useRef, useState } from "react";

interface Drag {
  value: number;
  max: number;
  paused: boolean;
}
export function SeekBar({
  position,
  duration,
  paused,
  preview,
  seek,
}: {
  position: number;
  duration: number;
  paused: boolean;
  preview: (value: number | null) => void;
  seek: (value: number, paused: boolean) => void;
}) {
  const transaction = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const begin = () => {
    if (!transaction.current)
      transaction.current = { value: position, max: duration, paused };
    return transaction.current;
  };
  const change = (value: number) => {
    const next = { ...begin(), value };
    transaction.current = next;
    setDrag(next);
    preview(value);
  };
  const finish = (commit: boolean) => {
    const current = transaction.current;
    transaction.current = null;
    setDrag(null);
    preview(null);
    if (commit && current)
      seek(Math.min(current.value, duration), current.paused);
  };
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];
  return (
    <input
      aria-label="播放位置"
      type="range"
      min="0"
      max={drag?.max ?? duration}
      step="0.01"
      disabled={duration <= 0}
      value={Math.min(drag?.value ?? position, drag?.max ?? duration)}
      onPointerDown={(e) => {
        setDrag({ ...begin() });
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onChange={(e) => change(Number(e.currentTarget.value))}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => {
        if (transaction.current) finish(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (keys.includes(e.key)) {
          e.preventDefault();
          const current = begin();
          const delta = e.key.startsWith("Page") ? 30 : 5;
          change(
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? current.max
                : Math.max(
                    0,
                    Math.min(
                      current.max,
                      current.value +
                        (["ArrowLeft", "ArrowDown", "PageDown"].includes(e.key)
                          ? -delta
                          : delta),
                    ),
                  ),
          );
        }
      }}
      onKeyUp={(e) => {
        if (keys.includes(e.key)) finish(true);
      }}
      onBlur={() => finish(true)}
    />
  );
}
