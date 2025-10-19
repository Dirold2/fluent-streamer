"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const stream_1 = require("stream");
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
class PluginHotSwap extends stream_1.Transform {
    current;
    next;
    swapping = false;
    destroyed = false;
    /**
     * Create a new PluginHotSwap.
     * @param initial The initial Transform stream (plugin or pipeline).
     */
    constructor(initial) {
        super();
        this.current = initial;
        this.attach(this.current);
    }
    /**
     * Attach necessary listeners to the provided Transform to properly forward output
     * and error events.
     * @private
     * @param chain Transform to attach.
     */
    attach(chain) {
        chain.on("data", (chunk) => {
            if (!this.push(chunk))
                chain.pause();
        });
        chain.once("error", (err) => this.emit("error", err));
        chain.once("end", () => {
            if (!this.swapping)
                this.push(null);
        });
    }
    /**
     * Remove only our attached event listeners from a Transform.
     * Does not tamper with user listeners.
     * @private
     * @param chain Transform to detach.
     */
    detach(chain) {
        chain.removeAllListeners("data");
        chain.removeAllListeners("error");
        chain.removeAllListeners("end");
    }
    /**
     * @inheritdoc
     * Handles main transform logic, forwarding data to the current and (when swapping)
     * next transform. Ensures at-most-once callback for each written chunk.
     */
    _transform(chunk, encoding, callback) {
        if (this.next && this.swapping) {
            // During a soft swap, feed both transforms to pre-warm next
            this.next.write(chunk, encoding);
            this.current.write(chunk, encoding, callback);
        }
        else {
            // Ensure 'drain' is respected for proper backpressure
            if (!this.current.write(chunk, encoding)) {
                this.current.once("drain", callback);
            }
            else {
                callback();
            }
        }
    }
    /**
     * @inheritdoc
     * Forwards end/flush call to the current Transform.
     */
    _flush(callback) {
        this.current.end(callback);
    }
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
    async swap(newChain, opts = {}) {
        if (this.destroyed)
            return;
        const soft = opts.soft ?? true;
        // Fast state sync without stream replace if compatible
        if (this.areCompatible(this.current, newChain)) {
            this.copyState(this.current, newChain);
            return;
        }
        if (!soft) {
            this.performHardSwap(newChain);
            return;
        }
        // Soft swap process
        this.swapping = true;
        this.next = newChain;
        this.attach(this.next);
        setImmediate(() => {
            const old = this.current;
            this.current = this.next;
            this.next = undefined;
            this.detach(old);
            old.end();
            this.swapping = false;
        });
    }
    /**
     * Instantly swap out the current Transform for a new one (hard swap).
     * @private
     * @param newChain The new Transform.
     */
    performHardSwap(newChain) {
        const old = this.current;
        this.detach(old);
        old.destroy();
        this.current = newChain;
        this.attach(this.current);
    }
    /**
     * Determine if two Transforms are compatible for a fast state-only swap.
     * Currently checks constructor and getOptions/setOptions methods.
     * @private
     * @param a First transform
     * @param b Second transform
     * @returns {boolean}
     */
    areCompatible(a, b) {
        return (a.constructor === b.constructor &&
            typeof a.setOptions === "function" &&
            typeof b.getOptions === "function");
    }
    /**
     * Synchronize options/state from source to the target transform, if possible.
     * @private
     * @param target Transform to apply state
     * @param source Transform to read state from
     */
    copyState(target, source) {
        if (typeof source.getOptions === "function" &&
            typeof target.setOptions === "function") {
            try {
                const opts = source.getOptions();
                target.setOptions(opts);
            }
            catch (e) {
                // If option transfer goes wrong, do nothing but avoid crash
            }
        }
    }
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
    destroy(err) {
        if (this.destroyed)
            return this;
        this.destroyed = true;
        this.detach(this.current);
        this.current.destroy();
        if (this.next) {
            this.detach(this.next);
            this.next.destroy();
        }
        return super.destroy(err ?? undefined);
    }
}
exports.default = PluginHotSwap;
//# sourceMappingURL=PluginHotSwap.js.map