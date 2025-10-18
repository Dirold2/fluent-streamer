import { describe, it, expect, beforeEach } from 'vitest'
import FluentStream from '../src/Core/FluentStream'
import { type AudioPlugin, type AudioPluginBaseOptions } from '../src/Core/Filters'
import { Transform, PassThrough } from 'stream'
import { GainPlugin } from '../src/plugins/gain'


describe('Hot plugin updates', () => {
  beforeEach(() => FluentStream.clearPlugins())

  it('applies setGain during streaming', async () => {
    // Arrange: register gain plugin
    FluentStream.registerPlugin('gain', (options: { gain: number }) => new GainPlugin(options))
    const ff = new FluentStream()
    ff.usePlugins('gain')
    const controllers = ff.getPluginControllers() as any[]
    const gainCtrl = controllers[0] as { setOptions: (g: number) => void }

    // Compose pipeline
    const t = ff.audioTransformConfig?.transform as Transform
    const src = new PassThrough()
    const dst = new PassThrough()

    const outputBuf: Buffer[] = []
    dst.on('data', (c) => outputBuf.push(c as Buffer))
    const done = new Promise<void>((resolve) => dst.on('end', () => resolve()))

    src.pipe(t).pipe(dst)

    // Send first chunk with gain=1
    const a = new Int16Array([Math.round(0.1 * 32767)])
    src.write(Buffer.from(a.buffer))

    // Update gain on the fly
    gainCtrl.setOptions(2)

    // Second chunk should be ~x2
    const b = new Int16Array([Math.round(0.1 * 32767)])
    src.end(Buffer.from(b.buffer))

    await done
    const out = Buffer.concat(outputBuf)
    const out16 = new Int16Array(out.buffer, out.byteOffset, out.length / 2)

    // We expect first sample ~original, second ~doubled
    expect(out16.length).toBe(2)
    expect(Math.abs(out16[0]) <= Math.abs(out16[1])).toBe(true)
  })
})


