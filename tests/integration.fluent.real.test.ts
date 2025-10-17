import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { FluentStream } from '../src/Core/FluentStream'

const RUN_REAL = process.env.RUN_REAL === '1'
const OUT_DIR = join(process.cwd(), 'tests', '.tmp')

function ensureTmpDir() {
  try { mkdirSync(OUT_DIR, { recursive: true }) } catch {}
}

;(RUN_REAL ? describe : describe.skip)('FluentStream (real ffmpeg)', () => {
  beforeAll(() => {
    ensureTmpDir()
  })

  it.runIf(RUN_REAL)('transcodes generated sample into matroska file', async () => {
    const srcPath = join(OUT_DIR, `source_${Date.now()}.mkv`)
    const outPath = join(OUT_DIR, `fluent_${Date.now()}.mkv`)

    // Generate a small input using ffmpeg via shell-independent pipeline (lavfi to file)
    {
      const gen = new FluentStream()
        .inputOptions('-f', 'lavfi')
        .input('testsrc=size=160x120:rate=5')
        .duration(1)
        .videoCodec('libx264')
        .format('matroska')
        .output('pipe:1')
      const { output, done } = gen.run()
      const buf = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = []
        output.on('data', (c) => chunks.push(c))
        done.then(() => resolve(Buffer.concat(chunks)))
      })
      writeFileSync(srcPath, buf)
    }

    const cmd = new FluentStream()
      .input(srcPath)
      .videoCodec('libx264')
      .format('matroska')
      .output('pipe:1')

    const { output, done } = cmd.run()
    const chunks: Buffer[] = []
    output.on('data', (c) => chunks.push(c))
    await done
    const data = Buffer.concat(chunks)
    writeFileSync(outPath, data)

    // eslint-disable-next-line no-console
    console.log(`Fluent output: ${outPath}`)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1000)
  }, 60000)
})


