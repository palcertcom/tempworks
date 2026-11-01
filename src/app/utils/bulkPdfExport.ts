/**
 * Bulk PDF export helper.
 * Generates one PDF per record via @react-pdf/renderer, packages them
 * into a ZIP archive with JSZip, and downloads the result.
 *
 * Fallback: if zipping fails (e.g. JSZip missing), downloads the
 * individual PDFs sequentially instead of silently dropping the action.
 */
import type { ReactElement } from 'react';
import { pdf } from '@react-pdf/renderer';

/** Lazy-load JSZip so a missing install only downgrades to per-file fallback
 *  instead of breaking Vite's module graph for the whole app. */
async function loadJSZip(): Promise<any | null> {
  try {
    const mod = await import('jszip');
    return (mod as any).default ?? mod;
  } catch (err) {
    console.warn('[bulkPdfExport] JSZip not available, falling back to per-file downloads.', err);
    return null;
  }
}

export type BulkRenderFn<T> = (record: T) => Promise<ReactElement> | ReactElement;
export type BulkBlobFn<T> = (record: T) => Promise<Blob>;
export type BulkFilenameFn<T> = (record: T) => string;

export type BulkPdfExportOptions<T> = {
  records: T[];
  zipName: string;
  /** Render a react-pdf element for each record. Ignored when `buildBlob`
   *  is supplied — pass `buildBlob` instead when the final PDF needs
   *  post-processing (e.g. merging supporting documents via pdf-lib). */
  renderDoc?: BulkRenderFn<T>;
  /** Build the complete PDF blob for a record. Takes precedence over
   *  `renderDoc`. */
  buildBlob?: BulkBlobFn<T>;
  filename: BulkFilenameFn<T>;
  /** How many PDFs to render concurrently. Default 3. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

/** Sanitise a string for use inside filenames — keeps ASCII-alnum, dashes, underscores. */
export function safeFilename(input: string): string {
  return (input || 'record')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'record';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderToBlob<T>(record: T, renderDoc: BulkRenderFn<T>): Promise<Blob> {
  const element = await renderDoc(record);
  return pdf(element as any).toBlob();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onStep?: (done: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
      done++;
      onStep?.(done);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Generate one PDF per record and download them as a single ZIP. */
export async function exportRecordsAsPdfZip<T>(opts: BulkPdfExportOptions<T>): Promise<void> {
  const { records, zipName, renderDoc, buildBlob, filename, concurrency = 3, onProgress } = opts;
  if (!records.length) return;
  if (!buildBlob && !renderDoc) {
    throw new Error('exportRecordsAsPdfZip needs either buildBlob or renderDoc');
  }

  const total = records.length;
  onProgress?.(0, total);

  // 1. Produce every record as { name, blob } in parallel (bounded).
  //    buildBlob wins over renderDoc when both are provided.
  const parts = await mapWithConcurrency(
    records,
    async (rec) => {
      const blob = buildBlob
        ? await buildBlob(rec)
        : await renderToBlob(rec, renderDoc!);
      return { name: filename(rec), blob };
    },
    concurrency,
    (done) => onProgress?.(done, total),
  );

  // 2. Try to zip. If JSZip is unavailable at runtime, fall back to
  //    sequential downloads so the user never ends up with nothing.
  const JSZip = await loadJSZip();
  if (JSZip) {
    try {
      const zip = new JSZip();
      const used = new Set<string>();
      for (const { name, blob } of parts) {
        let safe = safeFilename(name);
        if (!safe.toLowerCase().endsWith('.pdf')) safe += '.pdf';
        let unique = safe;
        let i = 2;
        while (used.has(unique)) {
          unique = safe.replace(/\.pdf$/i, `_${i}.pdf`);
          i++;
        }
        used.add(unique);
        zip.file(unique, await blob.arrayBuffer());
      }
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const finalName = zipName.toLowerCase().endsWith('.zip') ? zipName : `${zipName}.zip`;
      downloadBlob(zipBlob, safeFilename(finalName.replace(/\.zip$/i, '')) + '.zip');
      return;
    } catch (err) {
      console.error('[bulkPdfExport] Zip packaging failed, falling back to per-file downloads', err);
    }
  }

  // Fallback: download individually, spaced slightly so browsers accept each one.
  for (let i = 0; i < parts.length; i++) {
    const { name, blob } = parts[i];
    let safe = safeFilename(name);
    if (!safe.toLowerCase().endsWith('.pdf')) safe += '.pdf';
    downloadBlob(blob, safe);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}
