import { describe, it, expect, beforeEach } from 'vitest'
import FluentStream from '../src/Core/FluentStream'
import { GainPlugin } from '../src/plugins/gain'
import { PassThrough } from 'stream'

describe('FluentStream.usePlugin (single)', () => {
  beforeEach(() => {
    FluentStream.clearPlugins()
  })

  it('registers gain and composes transform via usePlugin', async () => {
    // Register a gain plugin globally (gain x2)
    FluentStream.registerPlugin('gain', () => new GainPlugin(2))

    const ff = new FluentStream()
    ;(ff as any).usePlugin('gain')
    const t = (ff).audioTransformConfig?.transform as PassThrough

    // Prepare 2-channel s16le samples
    const samples = new Int16Array(2)
    samples[0] = Math.round(0.25 * 32767) // ~8192
    samples[1] = Math.round(-0.25 * 32768) // ~-8192
    const in0 = samples[0]
    const in1 = samples[1]
    const buf = Buffer.from(samples.buffer)

    const src = new PassThrough()
    const dst = new PassThrough()

    const result = new Promise<Int16Array>((resolve) => {
      const chunks: Buffer[] = []
      dst.on('data', (c) => chunks.push(c as Buffer))
      dst.on('end', () => {
        const out = Buffer.concat(chunks)
        resolve(new Int16Array(out.buffer, out.byteOffset, out.length / 2))
      })
    })

    src.pipe(t).pipe(dst)
    src.end(buf)

    const out = await result
    expect(out.length).toBe(2)

    // Compute expected with same scaling/clamp as plugins
    const scale = (v: number) => {
      let f = v / 32768
      f = Math.max(-1, Math.min(1, f * 2))
      return Math.round(f * 32767)
    }
    const expected0 = scale(in0)
    const expected1 = scale(in1)
    expect(out[0]).toBe(expected0)
    expect(out[1]).toBe(expected1)
  })
})


