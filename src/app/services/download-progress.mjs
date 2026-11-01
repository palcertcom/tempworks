/** Byte progress, deliberately no estimated percentage for chunked ZIP exports. */
export function trackDownload(body, onProgress, clock = () => Date.now()) {
  let bytes = 0;
  let last = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      const now = clock();
      if (now - last >= 200) { onProgress(bytes); last = now; }
      controller.enqueue(chunk);
    },
    flush() { onProgress(bytes); },
  }));
}
