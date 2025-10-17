import { describe, expect, it, vi, beforeEach, Mock } from 'vitest'
import { execa } from 'execa'
import { FluentStream } from '../src/Core/FluentStream'
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
  ;(proc as any).pid = 42
  queueMicrotask(() => {
    stdout.end()
    stderr.end()
    proc.emit('exit', code, null)
  })
  ;(execa as any as Mock).mockReturnValue(proc)
}

describe('FluentStream', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds args fluently and runs via Processor', async () => {
    mockExecaExit(0)
    const cmd = new FluentStream({ enableProgressTracking: false })
      .input('in.mp4')
      .videoCodec('libx264')
      .output('out.mp4')
    const { done } = cmd.run()
    await expect(done).resolves.toBeUndefined()
    const args = cmd.getArgs()
    expect(args).toEqual(['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'])
  })
})


