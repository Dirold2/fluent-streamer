import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { Processor } from '../src/Core/Processor'

const RUN_REAL = process.env.RUN_REAL === '1'
const OUT_DIR = join(process.cwd(), 'tests', '.tmp')

function ensureTmpDir() {
  try { mkdirSync(OUT_DIR, { recursive: true }) } catch {}
}

;(RUN_REAL ? describe : describe.skip)('Processor (real ffmpeg)', () => {
  beforeAll(() => {
    ensureTmpDir()
  })

  it.runIf(RUN_REAL)('generates a short video from lavfi testsrc (matroska)', async () => {
    const outPath = join(OUT_DIR, `processor_${Date.now()}.mkv`)

    const p = new Processor({ enableProgressTracking: true })
    p.setArgs([
      '-f', 'lavfi',
      '-i', 'testsrc=size=160x120:rate=10',
      '-t', '2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-f', 'matroska',
      'pipe:1',
    ])

    const { output, done } = p.run()
    const chunks: Buffer[] = []
    output.on('data', (c: Buffer<ArrayBufferLike>) => chunks.push(c))
    await done

    const data = Buffer.concat(chunks)
    writeFileSync(outPath, data)
    // eslint-disable-next-line no-console
    console.log(`Processor output: ${outPath}`)

    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1000)
  }, 30000)
})


