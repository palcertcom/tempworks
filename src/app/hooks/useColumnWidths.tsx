import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';

/**
 * Per-column width state with localStorage persistence and a drag handler.
 *
 * Usage in a list:
 *   const { widths, headStyle, startResize } = useColumnWidths('users-cols', {
 *     name: 200, email: 220, status: 120, actions: 160,
 *   });
 *   <Table className="table-fixed">
 *     <TableHead style={headStyle('name')}>
 *       Name <ResizeHandle onMouseDown={(e) => startResize('name', e)} />
 *     </TableHead>
 *     ...
 *     <TableBody className="[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top">…</TableBody>
 *
 * `defaults` are the initial widths in px. Stored values are merged on top.
 */
const MIN_COL_WIDTH = 60;

export interface ColumnWidthsApi {
  widths: Record<string, number>;
  headStyle: (key: string) => CSSProperties | undefined;
  startResize: (key: string, e: React.MouseEvent) => void;
  resetWidths: () => void;
}

export function useColumnWidths(
  storageKey: string,
  defaults: Record<string, number>,
): ColumnWidthsApi {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? { ...defaults, ...JSON.parse(saved) } : { ...defaults };
    } catch {
      return { ...defaults };
    }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [storageKey, widths]);

  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      key,
      startX: e.clientX,
      startW: widths[key] ?? defaults[key] ?? 150,
    };
    const onMove = (ev: MouseEvent) => {
      const st = dragRef.current;
      if (!st) return;
      const next = Math.max(MIN_COL_WIDTH, st.startW + (ev.clientX - st.startX));
      setWidths(prev => prev[st.key] === next ? prev : { ...prev, [st.key]: next });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widths, defaults]);

  const headStyle = useCallback((key: string): CSSProperties | undefined => {
    const w = widths[key];
    return w ? { width: w, minWidth: w, maxWidth: w } : undefined;
  }, [widths]);

  const resetWidths = useCallback(() => setWidths({ ...defaults }), [defaults]);

  return { widths, headStyle, startResize, resetWidths };
}

/** 6 px grab strip on the right edge of a table header. Drop inside a TableHead. */
export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 end-0 h-full w-1.5 cursor-col-resize select-none group/handle"
      aria-hidden="true"
      title="Drag to resize"
    >
      <span className="absolute top-1 bottom-1 end-0 w-px bg-border group-hover/handle:bg-primary" />
    </span>
  );
}

/** Tailwind class string that unlocks text wrapping on every <td> in a TableBody. */
export const WRAPPING_TBODY_CLASSES =
  '[&_td]:whitespace-normal [&_td]:break-words [&_td]:align-top';
