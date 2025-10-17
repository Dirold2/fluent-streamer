import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest'
import { PassThrough, Readable } from 'stream'
import { execa } from 'execa'
import { Processor } from '../src/Core/Processor'

vi.mock('execa', () => {
  return {
    execa: vi.fn(),
  }
})

function mockExecaSuccess(stdoutData: Buffer[] = [], stderrData: Buffer[] = []) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const proc: any = new PassThrough()
  ;(proc as any).stdout = stdout
  ;(proc as any).stderr = stderr
  ;(proc as any).stdin = stdin
  ;(proc as any).pid = 1234
  queueMicrotask(() => {
    stdout.on('resume', () => {})
    stderr.on('resume', () => {})
    stdout.on('drain', () => {})
    stderr.on('drain', () => {})
    stdout.cork()
    stderr.cork()
    stdout.uncork()
    stderr.uncork()
    stdout.end(Buffer.concat(stdoutData))
    stderr.end(Buffer.concat(stderrData))
    proc.emit('exit', 0, null)
  })
  ;(execa as any as Mock).mockReturnValue(proc)
}

describe('Processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs ffmpeg and resolves done on success', async () => {
    mockExecaSuccess([Buffer.from('ok')])
    const p = new Processor({ enableProgressTracking: false })
    p.setArgs(['-version'])
    const { output, done } = p.run()
    const chunks: Buffer[] = []
    output.on('data', (c) => chunks.push(c))
    await expect(done).resolves.toBeUndefined()
    expect(Buffer.concat(chunks).toString()).toContain('ok')
  })

  it('emits start and end events', async () => {
    mockExecaSuccess()
    const p = new Processor()
    p.setArgs(['-version'])
    const onStart = vi.fn()
    const onEnd = vi.fn()
    p.on('start', onStart)
    p.on('end', onEnd)
    const { done } = p.run()
    await done
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('pipes input stream to stdin', async () => {
    mockExecaSuccess()
    const p = new Processor()
    p.setArgs(['-i', 'pipe:0', '-f', 'mp4', 'pipe:1'])
    const input = Readable.from(Buffer.from('input-data'))
    p.setInputStreams([{ stream: input, index: 0 }])
    const { done } = p.run()
    await expect(done).resolves.toBeUndefined()
  })
})


