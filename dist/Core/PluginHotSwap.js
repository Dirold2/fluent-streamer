"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const stream_1 = require("stream");
/**
 * PluginHotSwap
 *
 * Advanced hot-swappable Transform chain for audio/video plugin pipelines.
 *
 * Allows runtime (hot) replacement of the internal Transform stream (plugin or chain of plugins),
 * with minimal or zero pause in streaming (soft swap), or instant replace (hard swap).
 * Designed to safely switch audio/video plugin pipelines in Node.js, preserving stream
 * state and ensuring compatibility with Node.js Transform contracts.
 *
 * **Features:**
 * - Hot (runtime) plugin swap (soft/hard variants)
 * - Zero-pause data flow with soft swap (seamless handoff)
 * - State transfer between compatible plugin transforms
 * - Safe listener attach/detach to prevent memory/resource leaks
 * - Full compatibility with Node.js streams
 *
 * @example <caption>Basic usage</caption>
 * ```ts
 * import PluginHotSwap from "./PluginHotSwap";
 * const transform1 = plugin1.createTransform();
 * const transform2 = plugin2.createTransform();
 *
 * const hotSwap = new PluginHotSwap(transform1);
 *
 * someInputStream.pipe(hotSwap).pipe(someOutputStream);
 *
 * // Swap in a new plugin pipeline at runtime (soft swap - default)
 * await hotSwap.swap(transform2);
 * ```
 *
 * @example <caption>Hard swap (immediate replacement)</caption>
 * ```ts
 * await hotSwap.swap(transform3, { soft: false });
 * ```
 */
class PluginHotSwap extends stream_1.Transform {
    current;
    next;
    swapping = false;
    destroyed = false;
    /**
     * Construct a PluginHotSwap instance.
     * @param initial The initial Transform stream (plugin chain) to use.
     *
     * @example
     * ```ts
     * const transform = myPlugin.createTransform();
     * const hotSwap = new PluginHotSwap(transform);
     * ```
     */
    constructor(initial) {
        super();
        this.current = initial;
        this.link(this.current);
    }
    /**
     * Internally attach stream events from the given chain to the outer PluginHotSwap.
     * Ensures 'data', 'error', and 'end' events are propagated or handled properly.
     * @private
     */
    link(chain) {
        chain.on("data", (chunk) => {
            if (!this.push(chunk))
                chain.pause();
        });
        chain.on("error", (err) => this.emit("error", err));
        chain.on("end", () => {
            if (!this.swapping)
                this.push(null);
        });
    }
    /**
     * Detach all event listeners for the given Transform,
     * preventing memory/resource leaks when swapping.
     * @private
     */
    unlink(chain) {
        chain.removeAllListeners("data");
        chain.removeAllListeners("error");
        chain.removeAllListeners("end");
    }
    /**
     * Internal stream transform logic.
     * Forwards writes to the current or both current and next (during swap) transforms.
     * @private
     */
    _transform(chunk, _enc, cb) {
        if (this.next && this.swapping) {
            // During soft swap: write to both next and current
            this.next.write(chunk);
            this.current.write(chunk, _enc, cb);
        }
        else {
            if (!this.current.write(chunk)) {
                this.current.once("drain", cb);
            }
            else
                cb();
        }
    }
    /**
     * Called when stream end is requested; forwards to internal Transform.
     * @private
     */
    _flush(cb) {
        this.current.end(cb);
    }
    /**
     * Swap the internal Transform to a new plugin chain, at runtime.
     *
     * - If soft swap (`opts.soft !== false`): does a seamless handoff between the current and new plugin chain,
     *   with essentially no lost or repeated data.
     * - If hard swap (`opts.soft === false`): immediately replaces and destroys the current transform.
     * - If the plugin transforms are "compatible" (see below),
     *   the new state's options are migrated before the swap.
     *
     * @param newChain The new Transform to swap in.
     * @param opts Options for swap:
     *   - soft: If true (default), perform a seamless handoff (soft swap). If false, instantly destroy and replace (hard swap).
     *
     * @returns Promise<void>
     * @example <caption>Soft (default) swap:</caption>
     * ```ts
     * await hotSwap.swap(newTransform);
     * ```
     * @example <caption>Hard swap:</caption>
     * ```ts
     * await hotSwap.swap(newTransform, { soft: false });
     * ```
     */
    async swap(newChain, opts = {}) {
        if (this.destroyed)
            return;
        const soft = opts.soft ?? true;
        // Reuse compatible plugin by transferring options/state.
        if (this.isCompatible(this.current, newChain)) {
            this.applyState(this.current, newChain);
            return;
        }
        if (!soft) {
            this.hardSwap(newChain);
            return;
        }
        // Soft swap: smooth handoff
        this.swapping = true;
        this.next = newChain;
        this.link(this.next);
        // After current tick, update to the new chain and clean up previous.
        setImmediate(() => {
            const old = this.current;
            this.current = this.next;
            this.next = undefined;
            this.unlink(old);
            old.end();
            this.swapping = false;
        });
    }
    /**
     * Immediately replace and destroy the current Transform (hard swap).
     * Used for forced, fast plugin pipeline replacements.
     *
     * @param newChain The new Transform to swap in.
     * @private
     */
    hardSwap(newChain) {
        const old = this.current;
        this.unlink(old);
        old.destroy();
        this.current = newChain;
        this.link(this.current);
    }
    /**
     * Determine if two plugin Transform chains are compatible for a fast state transfer swap.
     * This checks that they are of the same class and support getOptions/setOptions APIs.
     *
     * @param a Current Transform
     * @param b New Transform
     * @returns true if compatible, otherwise false.
     * @private
     */
    isCompatible(a, b) {
        return (a.constructor === b.constructor &&
            typeof a.setOptions === "function" &&
            typeof b.getOptions === "function");
    }
    /**
     * Transfers options/state between two compatible plugin transforms.
     * Calls source.getOptions() and applies via target.setOptions().
     *
     * @param target Transform to set state on (existing).
     * @param source Transform to get state from (new).
     * @private
     */
    applyState(target, source) {
        if (typeof source.getOptions === "function" &&
            typeof target.setOptions === "function") {
            const opts = source.getOptions();
            target.setOptions(opts);
        }
    }
    /**
     * Destroy this PluginHotSwap instance and all internal resources and streams.
     * Safely detaches/destroys any underlying plugin transforms.
     *
     * @param err Optional error to emit with the destroy operation.
     * @returns this
     *
     * @example <caption>Manual destruction</caption>
     * ```ts
     * hotSwap.destroy();
     * ```
     */
    destroy(err) {
        this.destroyed = true;
        this.unlink(this.current);
        this.current.destroy();
        this.next?.destroy();
        return super.destroy(err);
    }
}
exports.default = PluginHotSwap;
//# sourceMappingURL=PluginHotSwap.js.map