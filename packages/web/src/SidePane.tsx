import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

const WIDTH_KEY = "kc.changes.width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 560;
/** Never wider than this share of the window: the conversation must stay readable. */
const MAX_SHARE = 0.6;

const clampWidth = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), window.innerWidth * MAX_SHARE));

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return clampWidth(stored > 0 ? stored : DEFAULT_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export type SideTab = "changes" | "files";

/**
 * The drawer beside the transcript, with a tab for each way of answering
 * "what is in this project right now": Changes (what the agent reported
 * editing) and Files (what is on disk). One surface, since the reader
 * switches between them with the same question in mind. Drag its left edge
 * to resize; the width is kept in this browser, which is a convenience and
 * not conversation state.
 */
export function SidePane({
  tab,
  onTab,
  tabs,
  onClose,
  children,
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  /** Label and badge per tab, so the header can count without knowing how. */
  tabs: Record<SideTab, { label: string; badge?: ReactNode }>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(loadWidth);
  const pane = useRef<HTMLDivElement>(null);

  // Pointer capture keeps the drag alive when the cursor outruns the handle.
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // Nothing to do: the width just will not be remembered.
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    pane.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };

  return (
    <aside className="changes" ref={pane} tabIndex={-1} onKeyDown={onKeyDown} aria-label="Side pane" style={{ flexBasis: width }}>
      <div className="changes-resize" onPointerDown={startResize} title="Drag to resize" />
      <div className="changes-head" role="tablist">
        {(Object.keys(tabs) as SideTab[]).map((id) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`side-tab ${tab === id ? "active" : ""}`} onClick={() => onTab(id)}>
            {tabs[id].label}
            {tabs[id].badge}
          </button>
        ))}
        <button className="changes-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      {children}
    </aside>
  );
}
