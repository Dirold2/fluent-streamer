import { PassThrough } from "stream";
/**
 * Registers a PassThrough stream for a particular pipe output (pipe:2, pipe:3, ...).
 * Allows the main thread to access extra output streams directly from the worker.
 *
 * @param pipeNum The pipe number (e.g., 2 for pipe:2)
 * @param stream The PassThrough stream to associate with the extra output
 *
 * @example
 * // In main thread
 * const { setExtraOutputStream } = require("./ProcessorWorker");
 * const stream = new PassThrough();
 * setExtraOutputStream(2, stream);
 */
declare function setExtraOutputStream(pipeNum: number, stream: PassThrough): void;
/**
 * Exported for advanced Node.js integrations.
 * Allows main thread to register custom PassThrough streams
 * for extra pipe outputs from ffmpeg process in worker.
 *
 * @param pipeNum The pipe number (e.g., 2 for pipe:2)
 * @param stream The PassThrough stream to associate
 *
 * @example
 * import { setExtraOutputStream } from "./ProcessorWorker";
 * setExtraOutputStream(2, myPassThroughStream);
 */
export { setExtraOutputStream };
