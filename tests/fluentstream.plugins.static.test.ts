import { describe, it, expect, beforeEach } from 'vitest'
import FluentStream from '../src/Core/FluentStream'
import { type AudioPlugin, type AudioPluginOptions } from '../src/Core/Filters'
import { Transform, PassThrough } from 'stream'

class UpperPlugin implements AudioPlugin {
  name = 'upper'
  createTransform(_o: Required<AudioPluginOptions>): Transform {
    return new Transform({
      transform(chunk, _enc, cb) {
        const out = Buffer.from(chunk.toString('utf8').toUpperCase(), 'utf8')
        cb(null, out)
      },
    })
  }
}

class SuffixPlugin implements AudioPlugin {
  createTransform(_o: Required<AudioPluginOptions>): Transform {
    return new Transform({
      transform(chunk, _enc, cb) {
        const out = Buffer.concat([Buffer.from('['), chunk, Buffer.from(']')])
        cb(null, out)
      },
    })
  }
}

describe('FluentStream static plugin registry', () => {
  beforeEach(() => {
    FluentStream.clearPlugins()
  })

  it('registers and checks plugins globally', () => {
    expect(FluentStream.hasPlugin('upper')).toBe(false)
    FluentStream.registerPlugin('upper', () => new UpperPlugin())
    expect(FluentStream.hasPlugin('upper')).toBe(true)
  })

  it('usePlugins composes transforms from global registry', async () => {
    FluentStream.registerPlugin('upper', () => new UpperPlugin())
    FluentStream.registerPlugin('suffix', () => new SuffixPlugin())

    const ff = new FluentStream()
    const t = (ff).usePlugins('upper', 'suffix') && (ff).audioTransformConfig?.transform

    const src = new PassThrough()
    const dst = new PassThrough()
    const result = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      dst.on('data', (c) => chunks.push(c))
      dst.on('end', () => resolve(Buffer.concat(chunks)))
    })

    src.pipe(t as Transform).pipe(dst)
    src.end(Buffer.from('hello'))
    const out = await result
    expect(out.toString('utf8')).toBe('[HELLO]')
  })
})


