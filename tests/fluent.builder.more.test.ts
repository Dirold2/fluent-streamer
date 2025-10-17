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
  ;(proc as any).pid = 7
  queueMicrotask(() => {
    stdout.end()
    stderr.end()
    proc.emit('exit', code, null)
  })
  ;(execa as any as Mock).mockReturnValue(proc)
}

describe('FluentStream (more cases)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts inputOptions before last -i', async () => {
    mockExecaExit(0)
    const cmd = new FluentStream()
      .input('in1.mp4')
      .input('in2.mp4')
      .inputOptions('-re')
      .output('out.mp4')
    const { done } = cmd.run()
    await expect(done).resolves.toBeUndefined()
    const args = cmd.getArgs()
    // -re should be before the last -i (in2.mp4)
    const lastI = args.lastIndexOf('-i')
    expect(args[lastI - 1]).toBe('-re')
  })

  it('crossfadeAudio builds correct filter graph and mapping', async () => {
    mockExecaExit(0)
    const cmd = new FluentStream()
      .input('a.wav')
      .input('b.wav')
      .crossfadeAudio(3, { inputA: 0, inputB: 1, curve1: 'tri', curve2: 'tri' })
      .output('out.wav')
    const { done } = cmd.run()
    await expect(done).resolves.toBeUndefined()
    const args = cmd.getArgs()
    const fi = args.indexOf('-filter_complex')
    expect(fi).toBeGreaterThan(-1)
    expect(args[fi + 1]).toMatch(/acrossfade=d=3:c1=tri:c2=tri/)
    const mi = args.indexOf('-map')
    expect(args[mi + 1]).toBe('[aout]')
  })
})


