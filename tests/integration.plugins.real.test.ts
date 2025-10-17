import { describe, it, expect, beforeAll } from 'vitest'
import FluentStream from '../src/Core/FluentStream'
import { PassThrough } from 'stream'

// Simple plugins for integration: wrap text and uppercase to simulate transform chain
class UpperPlugin {
  createTransform() {
    const { Transform } = require('stream')
    return new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: Function) {
        try {
          const out = Buffer.from(chunk.toString('utf8').toUpperCase(), 'utf8')
          cb(null, out)
        } catch (e) {
          cb(e)
        }
      },
    })
  }
}

class BracketPlugin {
  createTransform() {
    const { Transform } = require('stream')
    return new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: Function) {
        try {
          const out = Buffer.concat([Buffer.from('['), chunk, Buffer.from(']')])
          cb(null, out)
        } catch (e) {
          cb(e)
        }
      },
    })
  }
}

describe('FluentStream (real ffmpeg) + usePlugins chain', () => {
  beforeAll(() => {
    FluentStream.clearPlugins()
    // Register runtime text plugins
    FluentStream.registerPlugin('upper', () => new UpperPlugin() as any)
    FluentStream.registerPlugin('bracket', () => new BracketPlugin() as any)
  })

  it('pipes generated text through JS transform chain and encodes to matroska', async () => {
    const text = 'hello world\n'
    const input = new PassThrough()

    // Build ffmpeg pipeline: read from stdin (pipe:0) as lavfi anullsrc is audio; but here we send bytes.
    // We'll simply encode to matroska as a passthrough container to exercise the pipeline mechanics.
    const ff = new FluentStream()
      .input(input)
      .outputOptions('-f', 'matroska')
      .output('pipe:1')

    // Insert our JS transforms via global registry
    ;(ff as FluentStream).usePlugins('upper', 'bracket')

    const { output, done } = ff.run()

    // Write payload and close stdin
    input.end(Buffer.from(text, 'utf8'))

    // Consume some bytes to ensure flow
    await new Promise<void>((resolve) => {
      let count = 0
      output.on('data', () => {
        if (++count > 0) resolve()
      })
      output.once('end', () => resolve())
    })

    await expect(done).resolves.toBeUndefined()
  })
})
