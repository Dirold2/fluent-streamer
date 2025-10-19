import { PassThrough } from "stream";
/**
 * Register or update extra PassThrough for a given ffmpeg pipeNum.
 *
 * @param pipeNum number
 * @param stream PassThrough
 * @example
 * setExtraOutputStream(4, new PassThrough())
 */
declare function setExtraOutputStream(pipeNum: number, stream: PassThrough): void;
export { setExtraOutputStream };
