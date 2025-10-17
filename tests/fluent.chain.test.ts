import { describe, it, expect } from 'vitest'
import PluginRegistry from '../src/Core/PluginRegistry'
import { type AudioPlugin, type AudioPluginOptions } from '../src/Core/Filters'
import { Transform, PassThrough } from 'stream'

class DoublePlugin implements AudioPlugin {
  createTransform(_options: Required<AudioPluginOptions>): Transform {
    return new Transform({
      transform(chunk, _enc, cb) {
        const out = Buffer.concat([chunk, chunk])
        cb(null, out)
      },
    })
  }
}

class IncrementPlugin implements AudioPlugin {
  createTransform(_options: Required<AudioPluginOptions>): Transform {
    return new Transform({
      transform(chunk, _enc, cb) {
        const out = Buffer.from(chunk)
        for (let i = 0; i < out.length; i++) out[i] = (out[i] + 1) & 0xff
        cb(null, out)
      },
    })
  }
}

describe('FluentChain', () => {
  it('composes transforms with getTransform()', async () => {
    const reg = new PluginRegistry()
    reg.register('double', () => new DoublePlugin())
    reg.register('inc', () => new IncrementPlugin())
    const chain = reg.chain('double', 'inc')
    const t = chain.getTransform()

    const src = new PassThrough()
    const dst = new PassThrough()

    const result = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      dst.on('data', (c) => chunks.push(c))
      dst.on('end', () => resolve(Buffer.concat(chunks)))
    })

    src.pipe(t).pipe(dst)
    src.end(Buffer.from([0x00, 0x01]))

    const out = await result
    // doubled => [0,1,0,1], then increment => [1,2,1,2]
    expect([...out]).toEqual([1, 2, 1, 2])
  })

  it('pipes source through chain to destination with pipe()', async () => {
    const reg = new PluginRegistry()
    reg.register('double', () => new DoublePlugin())
    reg.register('inc', () => new IncrementPlugin())
    const chain = reg.chain('double', 'inc')

    const src = new PassThrough()
    const dst = new PassThrough()
    const result = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      dst.on('data', (c) => chunks.push(c))
      dst.on('end', () => resolve(Buffer.concat(chunks)))
    })

    chain.pipe(src, dst)
    src.end(Buffer.from([0x02]))

    const out = await result
    // doubled => [2,2], then increment => [3,3]
    expect([...out]).toEqual([3, 3])
  })
})


