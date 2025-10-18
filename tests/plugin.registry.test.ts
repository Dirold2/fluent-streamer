import { describe, it, expect } from 'vitest'
import PluginRegistry from '../src/Core/PluginRegistry'
import { type AudioPlugin, type AudioPluginBaseOptions } from '../src/Core/Filters'
import { Transform, PassThrough } from 'stream'

class DummyPlugin implements AudioPlugin {
  name = 'dummy'
  createTransform(_options: Required<AudioPluginBaseOptions>): Transform {
    // Pass-through transform
    return new Transform({
      transform(chunk, _enc, cb) {
        cb(null, chunk)
      },
    })
  }
}

describe('PluginRegistry', () => {
  it('registers, checks, retrieves and creates plugins', () => {
    const reg = new PluginRegistry()
    reg.register('dummy', () => new DummyPlugin())

    expect(reg.has('dummy')).toBe(true)
    expect(typeof reg.get('dummy')).toBe('function')

    const plugin = reg.create('dummy', { sampleRate: 48000, channels: 2 })
    expect(plugin.createTransform).toBeTypeOf('function')
  })

  it('throws on missing plugin', () => {
    const reg = new PluginRegistry()
    expect(() => reg.create('nope', { sampleRate: 48000, channels: 2 })).toThrowError(
      /Plugin not found: nope/
    )
  })

  it('builds a chain and returns a working transform', async () => {
    const reg = new PluginRegistry()
    reg.register('dummy', () => new DummyPlugin())
    const chain = reg.chain('dummy')
    const t = chain.getTransform()

    const src = new PassThrough()
    const dst = new PassThrough()

    const resultPromise = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      dst.on('data', (c) => chunks.push(c))
      dst.on('end', () => resolve(Buffer.concat(chunks)))
    })

    src.pipe(t).pipe(dst)

    const input = Buffer.from([1, 2, 3, 4])
    src.end(input)

    const out = await resultPromise
    expect(out.equals(input)).toBe(true)
  })
})


