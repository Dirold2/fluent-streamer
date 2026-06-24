import { resolveBlobUrl as resolveBlobUrlHelper } from "../../Runner/FFmpegRunner.js";
import { getTimeString } from "../utils.js";

export function createStreamFromArrayBuffer(arrayBuffer: ArrayBuffer): ReadableStream<Uint8Array> {
  const data = new Uint8Array(arrayBuffer);
  let offset = 0;
  const chunkSize = 64 * 1024;

  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    },
  });
}

export function validateAudioData(arrayBuffer: ArrayBuffer): boolean {
  if (arrayBuffer.byteLength < 12) return false;

  const view = new Uint8Array(arrayBuffer);

  if (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) return true;
  if (view[0] === 0xff && (view[1]! & 0xe0) === 0xe0) return true;

  if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x47) {
    return view[8] === 0x57 && view[9] === 0x41 && view[10] === 0x56 && view[11] === 0x45;
  }

  if (view[0] === 0x4f && view[1] === 0x67 && view[2] === 0x67 && view[3] === 0x53) return true;
  if (view[0] === 0x66 && view[1] === 0x4c && view[2] === 0x61 && view[3] === 0x43) return true;
  if (view[0] === 0xff && (view[1]! & 0xf0) === 0xf0) return true;

  return arrayBuffer.byteLength > 100;
}

export async function resolveBlobToStream(
  blobUrl: string,
  log?: { verbose: boolean; loggerTag: string; logger: { info?: (msg: string) => void } },
): Promise<ReadableStream<Uint8Array>> {
  try {
    const arrayBuffer = await resolveBlobUrlHelper(blobUrl);

    if (!validateAudioData(arrayBuffer)) {
      throw new Error(
        `Blob URL ${blobUrl} does not contain valid audio data (size: ${arrayBuffer.byteLength} bytes)`,
      );
    }

    if (log?.verbose) {
      log.logger.info?.(
        `[${getTimeString()}] [${log.loggerTag}] ✅ Validated audio data from blob: ${arrayBuffer.byteLength} bytes`,
      );
    }

    return createStreamFromArrayBuffer(arrayBuffer);
  } catch (error) {
    throw new Error(`Failed to resolve blob URL ${blobUrl}: ${error}`);
  }
}
