import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { SimpleFFmpeg } from '../src/Core/FluentStream'

const RUN_REAL = process.env.RUN_REAL === '1'
const OUT_DIR = join(process.cwd(), 'tests', '.tmp')
const STREAM_URL = process.env.STREAM_URL || 'https://ext-strm-rusam02rtk-01.strm.yandex.net/music-v2/raw/ysign1=45ecef6c80ec1771f87f2a9a33360a3839782bae2e734b5fa04f8bd50851d129,lid=1639,pfx,secret_version=ver-1,sfx,source=mds,ts=69006129/0/1749121/70da7a06.102406747.6.68070362/320.mp3'

function ensureTmpDir() {
  try { mkdirSync(OUT_DIR, { recursive: true }) } catch {}
}

;(RUN_REAL ? describe : describe.skip)('SimpleFFmpeg (real URL input)', () => {
  it('downloads/transcodes a short segment from URL to mp3', async () => {
    ensureTmpDir()
    const outPath = join(OUT_DIR, `url_${Date.now()}.mp3`)

    // Build a small segment read to keep test fast
    const cmd = new SimpleFFmpeg({ enableProgressTracking: false })
      .input(STREAM_URL)
      .duration(5)
      .audioCodec('copy') // fastest path, avoid re-encode
      .format('mp3')
      .output('pipe:1')

    const { output, done } = cmd.run()
    const chunks: Buffer[] = []
    output.on('data', (c) => chunks.push(c))
    await done
    const data = Buffer.concat(chunks)
    writeFileSync(outPath, data)

    // eslint-disable-next-line no-console
    console.log(`URL test output: ${outPath}`)
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeGreaterThan(1024)
  }, 60000)
})


