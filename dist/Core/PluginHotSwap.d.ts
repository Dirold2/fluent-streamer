import { Transform, TransformCallback } from "stream";
/**
 * @class PluginHotSwap
 * @extends Transform
 *
 * @classdesc
 * A hot-swappable Transform stream, designed for dynamically replacing the internal plugin
 * pipeline (another Transform stream, or a chain of them) in an audio/video processing flow
 * at runtime, without losing data or requiring a pipeline reset.
 *
 * It supports two types of swap:
 *  - Soft swap (default): Seamless handoff with minimal/no pause; both old and new process data briefly.
 *  - Hard swap: Immediately destroys the old, swaps in the new without extra coordination.
 *
 * Safely manages stream listeners to prevent memory/resource leaks and ensures all event
 * forwarding is handled cleanly.
 *
 * @example <caption>Basic Usage (soft swap, default)</caption>
 * ```ts
 * import PluginHotSwap from "./PluginHotSwap";
 * const chainA = pluginA.createTransform();
 * const chainB = pluginB.createTransform();
 *
 * const hotSwap = new PluginHotSwap(chainA);
 * input.pipe(hotSwap).pipe(output);
 *
 * // At runtime, hot-swap the plugin chain
 * await hotSwap.swap(chainB);
 * ```
 *
 * @example <caption>Hard swap (instant replace)</caption>
 * ```ts
 * await hotSwap.swap(chainC, { soft: false });
 * ```
 */
export default class PluginHotSwap extends Transform {
    private current;
    private next?;
    private swapping;
    destroyed: boolean;
    /**
     * Create a new PluginHotSwap.
     * @param initial The initial Transform stream (plugin or pipeline).
     */
    constructor(initial: Transform);
    /**
     * Attach necessary listeners to the provided Transform to properly forward output
     * and error events.
     * @private
     * @param chain Transform to attach.
     */
    private attach;
    /**
     * Remove only our attached event listeners from a Transform.
     * Does not tamper with user listeners.
     * @private
     * @param chain Transform to detach.
     */
    private detach;
    /**
     * @inheritdoc
     * Handles main transform logic, forwarding data to the current and (when swapping)
     * next transform. Ensures at-most-once callback for each written chunk.
     */
    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void;
    /**
     * @inheritdoc
     * Forwards end/flush call to the current Transform.
     */
    _flush(callback: TransformCallback): void;
    /**
     * Hot-swap to a new internal Transform plugin/pipeline.
     *
     * If the two chains are compatible (same class, support options transfer),
     * it performs a fast options/state sync and does not actually replace the stream.
     *
     * Soft swap (default) hands off to the new transform smoothly before removing the old.
     * Hard swap instantly destroys the old one.
     *
     * @param newChain The new Transform to use.
     * @param [opts] Swap options.
     * @param [opts.soft=true] Whether to use soft swapping (default=true).
     * @returns Promise<void>
     *
     * @example
     * ```ts
     * await hotSwap.swap(newTransform); // soft swap (smooth handoff)
     * await hotSwap.swap(otherTransform, { soft: false }); // hard swap (instant replace)
     * ```
     */
    swap(newChain: Transform, opts?: {
        soft?: boolean;
    }): Promise<void>;
    /**
     * Instantly swap out the current Transform for a new one (hard swap).
     * @private
     * @param newChain The new Transform.
     */
    private performHardSwap;
    /**
     * Determine if two Transforms are compatible for a fast state-only swap.
     * Currently checks constructor and getOptions/setOptions methods.
     * @private
     * @param a First transform
     * @param b Second transform
     * @returns {boolean}
     */
    private areCompatible;
    /**
     * Synchronize options/state from source to the target transform, if possible.
     * @private
     * @param target Transform to apply state
     * @param source Transform to read state from
     */
    private copyState;
    /**
     * Destroy this PluginHotSwap instance and all internal transforms.
     * Idempotent. Unwires listeners and frees resources.
     * @param err Optional error
     * @returns this
     *
     * @example
     * ```ts
     * hotSwap.destroy();
     * ```
     */
    destroy(err?: Error | null): this;
}
