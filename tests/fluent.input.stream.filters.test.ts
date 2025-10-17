import { describe, it, expect, vi, Mock, beforeEach } from 'vitest'
import { execa } from 'execa'
import FluentStream from '../src/Core/FluentStream'
import { PassThrough } from 'stream'

vi.mock('execa', () => ({ execa: vi.fn() }))

function mockExecaExit(code: number) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const proc: any = new PassThrough()
  ;(proc as any).stdout = stdout
  ;(proc as any).stderr = stderr
  ;(proc as any).stdin = stdin
  ;(proc as any).pid = 100
  queueMicrotask(() => {
    stdout.end()
    stderr.end()
    proc.emit('exit', code, null)
  })
  ;(execa as any as Mock).mockReturnValue(proc)
}

describe('FluentStream with stream input and filters', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds args for stream input with default mp3 input format and filters', async () => {
    mockExecaExit(0)

    const inputStream = new PassThrough()
    const filters = ['volume=2', 'bass=g=5']

    const fluent = new FluentStream()
      .input(inputStream)
      .inputOptions('-f', 'mp3')
      .output('pipe:1')
      .audioCodec('pcm_s16le')
      .outputOptions('-f', 's16le', '-ar', '48000', '-ac', '2', '-af', filters.join(','))

    const { done } = fluent.run()
    // push some bytes and end input to allow pipeline to finish
    inputStream.end(Buffer.from([0x00, 0x01, 0x02]))
    await expect(done).resolves.toBeUndefined()

    const args = fluent.getArgs()
    expect(args).toEqual([
      '-f', 'mp3',
      '-i', 'pipe:0',
      'pipe:1',
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-af', filters.join(','),
    ])
  })

  it('builds args for stream input with explicit input format and filters', async () => {
    mockExecaExit(0)

    const inputStream = new PassThrough()
    const inputFormat = 'aac'
    const filters = ['treble=g=3']

    const fluent = new FluentStream()
      .input(inputStream)
      .inputOptions('-f', inputFormat)
      .output('pipe:1')
      .audioCodec('pcm_s16le')
      .outputOptions('-f', 's16le', '-ar', '48000', '-ac', '2', '-af', filters.join(','))

    const { done } = fluent.run()
    inputStream.end(Buffer.from([0x10, 0x20]))
    await expect(done).resolves.toBeUndefined()

    const args = fluent.getArgs()
    expect(args).toEqual([
      '-f', 'aac',
      '-i', 'pipe:0',
      'pipe:1',
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-af', filters.join(','),
    ])
  })
})


