export function createSilenceMs(
  durationMs = 100,
  sampleRate = 48000,
  channels = 2,
  currentBitrate = 128,
): ReadableStream<Uint8Array> {
  const bytesPerSecond = sampleRate * channels * 2;
  const silenceBytes = Math.floor((durationMs / 1000) * bytesPerSecond);
  const adaptiveChunkSize = Math.min(512, Math.max(128, (currentBitrate / 128) * 256));
  const chunkSize = Math.min(adaptiveChunkSize, silenceBytes);
  let silenceSent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (silenceSent >= silenceBytes) {
        controller.close();
        return;
      }

      const remaining = silenceBytes - silenceSent;
      const sendSize = Math.min(chunkSize, remaining);
      controller.enqueue(new Uint8Array(sendSize));
      silenceSent += sendSize;
    },
  });
}

export function createSilenceBuffer(
  durationMs = 100,
  sampleRate = 48000,
  channels = 2,
): Uint8Array {
  const bytesPerSample = 2;
  const totalBytes = Math.floor((durationMs / 1000) * sampleRate * channels * bytesPerSample);
  return new Uint8Array(totalBytes);
}
