import { Transform } from "node:stream";

import type { AudioProcessingOptions } from "../Types/index.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum volume level / Минимальный уровень громкости */
export const VOLUME_MIN = 0;

/** Maximum volume level / Максимальный уровень громкости */
export const VOLUME_MAX = 1;

/** Minimum bass level (dB) / Минимальный уровень баса */
export const BASS_MIN = -20;

/** Maximum bass level (dB) / Максимальный уровень баса */
export const BASS_MAX = 20;

/** Minimum treble level (dB) / Минимальный уровень верхних частот */
export const TREBLE_MIN = -20;

/** Maximum treble level (dB) / Максимальный уровень верхних частот */
export const TREBLE_MAX = 20;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert user-facing volume value to linear gain multiplier
 * Преобразовать значение громкости пользователя в линейный множитель усиления
 *
 * @param userVal - Value from -1 to 1
 * @param maxDb - Maximum dB range
 * @returns Linear gain multiplier
 */
export function userToGainLinear(userVal: number, maxDb = 12): number {
  const v = Math.max(-1, Math.min(1, userVal));
  const db = Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
  return Math.pow(10, db / 20);
}

/**
 * Convert user-facing value to dB gain
 * Преобразовать пользовательское значение в усиление в дБ
 *
 * @param userVal - Value from -1 to 1
 * @param maxDb - Maximum dB range
 * @returns Gain in dB
 */
export function userToGainDb(userVal: number, maxDb = 15): number {
  const v = Math.max(-1, Math.min(1, userVal));
  return Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
}

/**
 * Apply dynamic range compression to a single sample
 * Применить динамическое сжатие диапазона к одному сэмплу
 *
 * @param value - Audio sample (-1.0 to 1.0)
 * @param threshold - Compression threshold
 * @param ratio - Compression ratio
 * @returns Compressed sample
 */
export function compressSample(
  value: number,
  threshold = 0.8,
  ratio = 4,
): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return value;
  const excess = abs - threshold;
  const compressed = threshold + excess / ratio;
  return Math.sign(value) * compressed;
}

/**
 * Clamp volume to valid range
 * Ограничить громкость допустимым диапазоном
 */
export function clampVolume(volume: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, volume));
}

/**
 * Normalize bass value to -1..1 range
 * Нормализовать значение баса к диапазону -1..1
 */
export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

/**
 * Normalize treble value to -1..1 range
 * Нормализовать значение верхних частот к диапазону -1..1
 */
export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

// ============================================================================
// BIQUAD FILTER IMPLEMENTATION
// ============================================================================

/**
 * Коэффициенты biquad фильтра
 * Biquad filter coefficients
 */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Состояние biquad фильтра (Direct Form I)
 * Biquad filter state (Direct Form I)
 */
export interface BiquadState {
  x1: number; // x[n-1]
  x2: number; // x[n-2]
  y1: number; // y[n-1]
  y2: number; // y[n-2]
}

/**
 * Расчет коэффициентов Low-Shelf фильтра
 * Calculate Low-Shelf filter coefficients
 *
 * @param freq - Частота среза (Hz)
 * @param sampleRate - Частота дискретизации (Hz)
 * @param gainDb - Усиление в dB
 * @param Q - Q-фактор (обычно 0.7 для плавного наклона)
 */
export function calcLowShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 - (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
  const b2 = A * (A + 1 - (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 + (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = -2 * (A - 1 + (A + 1) * cosW0);
  const a2 = A + 1 + (A - 1) * cosW0 - sqrtA2Alpha;

  // Нормализация на a0
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Расчет коэффициентов High-Shelf фильтра
 * Calculate High-Shelf filter coefficients
 *
 * @param freq - Частота среза (Hz)
 * @param sampleRate - Частота дискретизации (Hz)
 * @param gainDb - Усиление в dB
 * @param Q - Q-фактор (обычно 0.7 для плавного наклона)
 */
export function calcHighShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
  const b2 = A * (A + 1 + (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 - (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosW0);
  const a2 = A + 1 - (A - 1) * cosW0 - sqrtA2Alpha;

  // Нормализация на a0
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Расчет коэффициентов Peaking EQ фильтра
 * Calculate Peaking EQ filter coefficients
 *
 * @param freq - Центральная частота (Hz)
 * @param sampleRate - Частота дискретизации (Hz)
 * @param gainDb - Усиление в dB
 * @param Q - Q-фактор (ширина полосы)
 */
export function calcPeakingCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  // Нормализация на a0
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * Применить biquad фильтр к сэмплу (Direct Form I)
 * Apply biquad filter to sample (Direct Form I)
 *
 * @param input - Входной сэмпл
 * @param coeffs - Коэффициенты фильтра
 * @param state - Состояние фильтра
 * @returns Выходной сэмпл
 */
export function processBiquad(
  input: number,
  coeffs: BiquadCoeffs,
  state: BiquadState,
): number {
  // Direct Form I: y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
  const output =
    coeffs.b0 * input +
    coeffs.b1 * state.x1 +
    coeffs.b2 * state.x2 -
    coeffs.a1 * state.y1 -
    coeffs.a2 * state.y2;

  // Обновить состояние
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;

  return output;
}

// ============================================================================
// AUDIO FILTER STATE
// ============================================================================

/**
 * State variables for improved audio equalizer filters
 * Переменные состояния для улучшенного эквалайзера
 */
export interface FilterState {
  // Bass section - используем 2 biquad фильтра
  bassShelfL: BiquadState;
  bassShelfR: BiquadState;
  bassPeakL: BiquadState;
  bassPeakR: BiquadState;

  // Treble section - используем 2 biquad фильтра
  trebleShelfL: BiquadState;
  trebleShelfR: BiquadState;
  treblePeakL: BiquadState;
  treblePeakR: BiquadState;
}

/**
 * Initialize biquad state
 * Инициализация состояния biquad фильтра
 */
function initBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

// ============================================================================
// AUDIO PROCESSOR CLASS
// ============================================================================

/**
 * Real-time PCM audio processor with improved EQ filters
 * Процессор аудио-потока PCM в реальном времени с улучшенными фильтрами
 * Format: 48 kHz, 16-bit stereo PCM s16le
 */
export class AudioProcessor extends Transform {
  public volume: number;
  public bass: number;
  public treble: number;
  public compressor: boolean;
  public normalize: boolean;

  public filterState: FilterState = {
    bassShelfL: initBiquadState(),
    bassShelfR: initBiquadState(),
    bassPeakL: initBiquadState(),
    bassPeakR: initBiquadState(),
    trebleShelfL: initBiquadState(),
    trebleShelfR: initBiquadState(),
    treblePeakL: initBiquadState(),
    treblePeakR: initBiquadState(),
  };

  private isDestroyed = false;
  private fadeActive = false;
  private fadeFrom = 1;
  private fadeTo = 1;
  private fadeSamplesTotal = 0;
  private fadeSamplesDone = 0;

  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly frameSizeBytes: number;
  private leftover: Buffer | null = null;

  constructor(
    options: AudioProcessingOptions & {
      sampleRate?: number;
      channels?: number;
    } = {
      volume: 1,
      bass: 0,
      treble: 0,
      compressor: false,
      normalize: false,
      sampleRate: 48000,
      channels: 2,
    },
  ) {
    super({
      readableObjectMode: false,
      writableObjectMode: false,
      allowHalfOpen: false,
      decodeStrings: true,
      highWaterMark: 4096,
    });

    this.sampleRate = options.sampleRate ?? 48000;
    this.channels = options.channels ?? 2;
    this.frameSizeBytes = this.channels * 2;

    this.volume = clampVolume(options.volume ?? 1);
    this.bass = normalizeBass(options.bass ?? 0);
    this.treble = normalizeTreble(options.treble ?? 0);
    this.compressor = !!options.compressor;
    this.normalize = !!options.normalize;

    this.setupEventHandlers();
  }

  public getSampleRate(): number {
    return this.sampleRate;
  }

  public getChannels(): number {
    return this.channels;
  }

  public setVolume(volume: number): void {
    if (this.isTerminated()) return;
    this.volume = clampVolume(volume);
  }

  public startFade(targetVolume: number, durationMs: number): void {
    if (this.isTerminated()) return;
    const to = clampVolume(targetVolume);
    const samples = Math.max(
      1,
      Math.round((durationMs / 1000) * this.sampleRate),
    );

    this.fadeFrom = this.volume;
    this.fadeTo = to;
    this.fadeSamplesTotal = samples;
    this.fadeSamplesDone = 0;
    this.fadeActive = true;

    this.emit("fade-start", {
      from: this.fadeFrom,
      to: this.fadeTo,
      durationMs,
    });
  }

  public setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isTerminated()) return;
    this.bass = normalizeBass(bass);
    this.treble = normalizeTreble(treble);
    this.compressor = compressor;
  }

  public setCompressor(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.compressor = enabled;
  }

  public setNormalize(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.normalize = enabled;
  }

  private shouldBypass(): boolean {
    return (
      !this.fadeActive &&
      !this.normalize &&
      this.volume === 1 &&
      Math.abs(this.bass) < 1e-6 &&
      Math.abs(this.treble) < 1e-6 &&
      !this.compressor
    );
  }

  private isTerminated(): boolean {
    return this.isDestroyed || this.destroyed || this.writableEnded;
  }

  private nextVolume(): number {
    if (!this.fadeActive) return this.volume;

    const progress =
      this.fadeSamplesTotal > 0
        ? Math.min(1, this.fadeSamplesDone / this.fadeSamplesTotal)
        : 1;

    const current = this.fadeFrom + (this.fadeTo - this.fadeFrom) * progress;
    this.fadeSamplesDone++;

    if (this.fadeSamplesDone >= this.fadeSamplesTotal) {
      this.volume = this.fadeTo;
      this.fadeActive = false;
      this.fadeSamplesDone = 0;
      this.fadeSamplesTotal = 0;
      this.emit("fade-end", { to: this.fadeTo });
    }

    return current;
  }

  private processStereoSample(
    left: number,
    right: number,
    volume: number,
  ): [number, number] {
    let l = (left * volume) / 32768;
    let r = (right * volume) / 32768;

    if (Math.abs(this.bass) > 0.001) {
      [l, r] = this.applyBassFilter(l, r);
    }

    if (Math.abs(this.treble) > 0.001) {
      [l, r] = this.applyTrebleFilter(l, r);
    }

    if (this.compressor) {
      l = compressSample(l);
      r = compressSample(r);
    }

    l = l < -1 ? -1 : l > 1 ? 1 : l;
    r = r < -1 ? -1 : r > 1 ? 1 : r;

    const outL = (l * 32767 + (l < 0 ? -0.5 : 0.5)) | 0;
    const outR = (r * 32767 + (r < 0 ? -0.5 : 0.5)) | 0;

    return [outL, outR];
  }

  /**
   * Применить улучшенные басовые фильтры
   * Apply improved bass filters
   */
  private applyBassFilter(l: number, r: number): [number, number] {
    const bassGainDb = userToGainDb(this.bass, 18);

    // 1. Low-Shelf фильтр на 120 Hz (основной бас)
    const shelfCoeffs = calcLowShelfCoeffs(
      120,
      this.sampleRate,
      bassGainDb,
      0.7,
    );

    l = processBiquad(l, shelfCoeffs, this.filterState.bassShelfL);
    r = processBiquad(r, shelfCoeffs, this.filterState.bassShelfR);

    // 2. Peaking EQ на 60 Hz для глубокого баса (опционально при большом усилении)
    if (Math.abs(bassGainDb) > 6) {
      const peakQ = 1.0; // Узкая полоса для точного контроля
      const peakCoeffs = calcPeakingCoeffs(
        60,
        this.sampleRate,
        bassGainDb * 0.5, // Меньше усиления чем shelf
        peakQ,
      );

      l = processBiquad(l, peakCoeffs, this.filterState.bassPeakL);
      r = processBiquad(r, peakCoeffs, this.filterState.bassPeakR);
    }

    return [l, r];
  }

  /**
   * Применить улучшенные фильтры высоких частот
   * Apply improved treble filters
   */
  private applyTrebleFilter(l: number, r: number): [number, number] {
    const trebleGainDb = userToGainDb(this.treble, 12);

    // 1. High-Shelf фильтр на 8000 Hz (основные высокие частоты)
    const shelfCoeffs = calcHighShelfCoeffs(
      8000,
      this.sampleRate,
      trebleGainDb,
      0.7,
    );

    l = processBiquad(l, shelfCoeffs, this.filterState.trebleShelfL);
    r = processBiquad(r, shelfCoeffs, this.filterState.trebleShelfR);

    // 2. Peaking EQ на 12000 Hz для воздушности (опционально при усилении)
    if (trebleGainDb > 3) {
      const peakQ = 1.2; // Умеренная ширина
      const peakCoeffs = calcPeakingCoeffs(
        12000,
        this.sampleRate,
        trebleGainDb * 0.3, // Небольшое усиление для воздушности
        peakQ,
      );

      l = processBiquad(l, peakCoeffs, this.filterState.treblePeakL);
      r = processBiquad(r, peakCoeffs, this.filterState.treblePeakR);
    }

    return [l, r];
  }

  private setupEventHandlers(): void {
    this.on("close", () => {
      this.isDestroyed = true;
      this.leftover = null;
    });
  }

  private processPcmBufferAligned(buffer: Buffer): Buffer {
    if (buffer.length === 0) return buffer;
    if (this.shouldBypass()) {
      return buffer;
    }

    const out = Buffer.from(buffer);
    const samples = new Int16Array(
      out.buffer,
      out.byteOffset,
      out.byteLength / 2,
    );

    const frameCount = out.byteLength / this.frameSizeBytes;
    const hasFade = this.fadeActive;
    let currentVolume = this.volume;

    let normalizeScale = 1;
    if (this.normalize) {
      let peak = 0;
      const totalSamples = samples.length;
      for (let i = 0; i < totalSamples; i++) {
        const v = samples[i];
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }

      if (peak > 0) {
        normalizeScale = 32767 / peak;
      }
    }

    for (let frame = 0; frame < frameCount; frame++) {
      const idx = frame * this.channels;
      const left = samples[idx];
      const right = samples[idx + 1] ?? left;

      if (hasFade) {
        currentVolume = this.nextVolume();
      }

      let [pl, pr] = this.processStereoSample(left, right, currentVolume);

      if (this.normalize && normalizeScale !== 1) {
        pl = (pl * normalizeScale) | 0;
        pr = (pr * normalizeScale) | 0;
      }

      samples[idx] = pl;
      if (this.channels > 1) {
        samples[idx + 1] = pr;
      }
    }

    return out;
  }

  private splitAligned(input: Buffer): {
    aligned: Buffer;
    remainder: Buffer | null;
  } {
    const remainderBytes = input.length % this.frameSizeBytes;
    const alignedBytes = input.length - remainderBytes;

    if (alignedBytes === 0) {
      return { aligned: Buffer.alloc(0), remainder: input };
    }

    const aligned = input.subarray(0, alignedBytes);
    const remainder = remainderBytes > 0 ? input.subarray(alignedBytes) : null;

    return { aligned, remainder };
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (err?: Error | null, data?: Buffer) => void,
  ): void {
    try {
      if (this.isTerminated()) return callback();

      const input = this.leftover
        ? Buffer.concat([this.leftover, chunk])
        : chunk;

      const { aligned, remainder } = this.splitAligned(input);
      this.leftover = remainder;

      if (aligned.length === 0) {
        return callback();
      }

      const processed = this.processPcmBufferAligned(aligned);
      return callback(undefined, processed);
    } catch (err) {
      this.destroy(err as Error);
      return callback();
    }
  }

  override _flush(
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    try {
      if (this.leftover && this.leftover.length > 0) {
        const padBytes =
          (this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes)) %
          this.frameSizeBytes;

        const padded = padBytes
          ? Buffer.concat([this.leftover, Buffer.alloc(padBytes, 0)])
          : this.leftover;

        this.leftover = null;

        const processed = this.processPcmBufferAligned(padded);
        if (processed.length > 0) {
          this.push(processed);
        }
      }

      callback();
    } catch (e) {
      callback(e as Error);
    }
  }

  override destroy(error?: Error): this {
    if (this.isDestroyed) return this;
    this.isDestroyed = true;
    this.leftover = null;
    return super.destroy(error);
  }

  public processBuffer(buffer: Buffer): Buffer {
    if (this.isTerminated()) {
      return Buffer.alloc(0);
    }

    if (buffer.length === 0) {
      return Buffer.alloc(0);
    }

    const input = this.leftover
      ? Buffer.concat([this.leftover, buffer])
      : buffer;

    const { aligned, remainder } = this.splitAligned(input);
    this.leftover = remainder;

    if (aligned.length === 0) {
      return Buffer.alloc(0);
    }

    return this.processPcmBufferAligned(aligned);
  }

  public flushBuffer(): Buffer {
    if (this.isTerminated()) {
      this.leftover = null;
      return Buffer.alloc(0);
    }

    if (!this.leftover || this.leftover.length === 0) {
      return Buffer.alloc(0);
    }

    const padBytes =
      (this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes)) %
      this.frameSizeBytes;

    const padded = padBytes
      ? Buffer.concat([this.leftover, Buffer.alloc(padBytes, 0)])
      : this.leftover;

    this.leftover = null;

    return this.processPcmBufferAligned(padded);
  }
}
