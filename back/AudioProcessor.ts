import { AudioProcessingOptions } from "../Types/index.js";
import { Transform } from "stream";

// Экспортируем константы для стороннего использования, например в @Processor.ts
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const BASS_MIN = -20;
export const BASS_MAX = 20;
export const TREBLE_MIN = -20;
export const TREBLE_MAX = 20;

// Вспомогательные функции и тип состояния фильтров
export interface FilterState {
  trebleL: number;
  trebleR: number;
  bass60L: number;
  bass60R: number;
  bass120L: number;
  bass120R: number;
  bassLowpassL: number;
  bassLowpassR: number;
}

export const SAMPLE_RATE = 48000;

export function userToGainLinear(userVal: number, maxDb = 12): number {
  const v = Math.max(-1, Math.min(1, userVal));
  const db = Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
  return Math.pow(10, db / 20);
}

export function userToGainDb(userVal: number, maxDb = 15): number {
  const v = Math.max(-1, Math.min(1, userVal));
  return Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
}

export function compressSample(value: number, threshold = 0.8, ratio = 4): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return value;
  const excess = abs - threshold;
  const compressed = threshold + excess / ratio;
  return Math.sign(value) * compressed;
}

// Утилиты для @Processor.ts и других
export function clampVolume(volume: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, volume));
}

export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

/**
 * AudioProcessor - класс для Stereo PCM потоковой обработки и динамической регулировки эффектов.
 * Легко использовать в @Processor.ts: исползуйте публичные методы и утилиты как вам нужно.
 */
export class AudioProcessor extends Transform {
  public volume: number;
  public bass: number;
  public treble: number;
  public compressor: boolean;
  private isFading = false;
  public lastVolume: number;
  private isDestroyed = false;

  // Fade params
  private fadeStartTime: number | null = null;
  private fadeDuration = 0;
  private fadeFrom = 0;
  private fadeTo = 0;

  public filterState: FilterState = {
    trebleL: 0,
    trebleR: 0,
    bass60L: 0,
    bass60R: 0,
    bass120L: 0,
    bass120R: 0,
    bassLowpassL: 0,
    bassLowpassR: 0,
  };

  constructor(options: AudioProcessingOptions) {
    super();
    this.volume = clampVolume(options.volume);
    this.lastVolume = this.volume;
    this.bass = normalizeBass(options.bass);
    this.treble = normalizeTreble(options.treble);
    this.compressor = !!options.compressor;
    this.setupEventHandlers();
  }

  // --- API для @Processor.ts (Публичные методы) ---

  setVolume(volume: number): void {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] setVolume ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded, volume });
      return;
    }
    console.debug('[AudioProcessor][debug] setVolume', { volume });
    this.lastVolume = this.volume;
    this.volume = clampVolume(volume);
  }

  // FIX: Добавлены события fade-start / fade-end
  startFade(targetVolume: number, duration: number): void {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] startFade ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded, targetVolume, duration });
      return;
    }
    console.debug('[AudioProcessor][debug] startFade', { targetVolume, duration });
    this.isFading = true;
    this.fadeFrom = this.volume;
    this.fadeTo = clampVolume(targetVolume);
    this.fadeStartTime = Date.now();
    this.fadeDuration = duration;
    this.emit("fade-start", { from: this.fadeFrom, to: this.fadeTo });
  }

  setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] setEqualizer ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded, bass, treble, compressor });
      return;
    }
    console.debug('[AudioProcessor][debug] setEqualizer', { bass, treble, compressor });
    this.bass = normalizeBass(bass);
    this.treble = normalizeTreble(treble);
    this.compressor = compressor;
  }

  setCompressor(enabled: boolean): void {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] setCompressor ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded, enabled });
      return;
    }
    console.debug('[AudioProcessor][debug] setCompressor', { enabled });
    this.compressor = enabled;
  }

  // --- Публичный метод быстрой обработки PCM-пары (для сторонних случаев) ---
  processStereoSample(left: number, right: number, currentVolume?: number): [number, number] {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] processStereoSample ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded });
      return [left, right];
    }
    const volume = typeof currentVolume === "number" ? currentVolume : this.volume;
    return this.processAudioSample(left, right, volume);
  }

  // --- PATCH/FIX: Основная потоковая обработка с плавным fade на каждый sample ---
  override _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: any) => void): void {
    if (this.isDestroyed || this.destroyed || (this as any).writableEnded) {
      console.debug('[AudioProcessor][debug] _transform ignored: stream ended', { destroyed: this.destroyed, isDestroyed: this.isDestroyed, writableEnded: (this as any).writableEnded, chunkLength: chunk?.length });
      callback();
      return;
    }
    console.debug('[AudioProcessor][debug] _transform', { chunkLength: chunk?.length });

    try {
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      const frameCount = samples.length / 2;

      for (let frame = 0; frame < frameCount; frame++) {
        const idx = frame * 2;
        const left = samples[idx];
        const right = samples[idx + 1] ?? left;
        const currentVolume = this.updateFadeVolumeForSample(frame, frameCount);

        const [processedLeft, processedRight] = this.processAudioSample(
          left,
          right,
          currentVolume
        );

        samples[idx] = processedLeft;
        samples[idx + 1] = processedRight;
      }

      this.lastVolume = this.volume;
      // === NEW GUARD ===
      if (!this.writable || this.destroyed || (this as any).writableEnded) {
        console.debug('[AudioProcessor][debug] _transform: downstream already ended, dropping chunk');
        callback();
        return;
      }
      callback(null, chunk);
    } catch (error) {
      console.error("[AudioProcessor] Transform error:", error);
      this.safeDestroy();
      callback();
    }
  }

  // PATCH: Плавный fade — перерасчёт громкости по sample (фиксированный расчёт)
  private updateFadeVolumeForSample(sampleIndex: number, frameCount: number): number {
    if (!this.isFading || this.fadeStartTime === null || this.fadeDuration <= 0) return this.volume;
    const now = Date.now();
    const elapsed = now - this.fadeStartTime; // ms

    // длительность всего текущего буфера в миллисекундах
    const chunkDurationMs = (frameCount / SAMPLE_RATE) * 1000;

    // смещение времени внутри буфера (ms) для этого sample'а
    const sampleOffsetMs = (sampleIndex / frameCount) * chunkDurationMs;

    const totalElapsed = elapsed + sampleOffsetMs;
    if (totalElapsed >= this.fadeDuration) {
      this.volume = this.fadeTo;
      this.isFading = false;
      this.fadeStartTime = null;
      this.emit("fade-end", { to: this.fadeTo });
      return this.volume;
    }

    const progress = Math.max(0, totalElapsed / this.fadeDuration);
    return this.fadeFrom + (this.fadeTo - this.fadeFrom) * progress;
  }

  // --- Обработка одного сэмпла стерео с применением всех эффектов ---
  private processAudioSample(left: number, right: number, currentVolume: number): [number, number] {
    let l = left / 32768;
    let r = right / 32768;

    l *= currentVolume;
    r *= currentVolume;

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

    l = Math.max(-1, Math.min(1, l));
    r = Math.max(-1, Math.min(1, r));

    return [Math.round(l * 32767), Math.round(r * 32767)];
  }

  private applyBassFilter(l: number, r: number): [number, number] {
    const bassGainDb = userToGainDb(this.bass, 18);

    const lowpassFreq =
      bassGainDb >= 0
        ? 4000 - (bassGainDb / 18) * 110
        : 4000 + (Math.abs(bassGainDb) / 18) * 1000;

    const lowpassQ =
      bassGainDb >= 0
        ? 0.7 + (bassGainDb / 18) * 1.8
        : 0.7 - (Math.abs(bassGainDb) / 18) * 0.4;

    const bassGain60 = userToGainLinear(this.bass * 0.7, 18);
    const alpha60 = (2 * Math.PI * 60) / SAMPLE_RATE;

    this.filterState.bass60L += alpha60 * (l - this.filterState.bass60L);
    this.filterState.bass60R += alpha60 * (r - this.filterState.bass60R);

    l += this.filterState.bass60L * (bassGain60 - 1);
    r += this.filterState.bass60R * (bassGain60 - 1);

    const eqGain120 = userToGainLinear(this.bass * 0.5, 18);
    const alpha120 = (2 * Math.PI * 120) / SAMPLE_RATE;

    this.filterState.bass120L += alpha120 * (l - this.filterState.bass120L);
    this.filterState.bass120R += alpha120 * (r - this.filterState.bass120R);

    l += this.filterState.bass120L * (eqGain120 - 1);
    r += this.filterState.bass120R * (eqGain120 - 1);

    const effectiveAlpha = (2 * Math.PI * lowpassFreq) / SAMPLE_RATE;
    const qInfluence = Math.min(lowpassQ * 0.5, 0.95);

    this.filterState.bassLowpassL =
      this.filterState.bassLowpassL * (1 - effectiveAlpha * qInfluence) +
      l * effectiveAlpha * qInfluence;
    this.filterState.bassLowpassR =
      this.filterState.bassLowpassR * (1 - effectiveAlpha * qInfluence) +
      r * effectiveAlpha * qInfluence;

    const blendFactor = 0.3 + (lowpassQ - 0.7) * 0.2;

    l = this.filterState.bassLowpassL + (l - this.filterState.bassLowpassL) * blendFactor;
    r = this.filterState.bassLowpassR + (r - this.filterState.bassLowpassR) * blendFactor;

    if (Math.abs(bassGainDb) > 6) {
      l = this.applyLimiter(l);
      r = this.applyLimiter(r);
    }

    return [l, r];
  }

  private applyTrebleFilter(l: number, r: number): [number, number] {
    const trebleGain = userToGainLinear(this.treble, 12);
    const alphaTreble = (2 * Math.PI * 4000) / SAMPLE_RATE;

    const lpStateL = this.filterState.trebleL + alphaTreble * (l - this.filterState.trebleL);
    const lpStateR = this.filterState.trebleR + alphaTreble * (r - this.filterState.trebleR);

    const highPassL = l - lpStateL;
    const highPassR = r - lpStateR;

    this.filterState.trebleL = lpStateL;
    this.filterState.trebleR = lpStateR;

    l += highPassL * (trebleGain - 1);
    r += highPassR * (trebleGain - 1);

    return [l, r];
  }

  private applyLimiter(value: number, threshold = 0.85, ratio = 8): number {
    const abs = Math.abs(value);
    if (abs <= threshold) return value;
    const excess = abs - threshold;
    const compressed = threshold + excess / ratio;
    return Math.sign(value) * compressed;
  }

  // FIX: Удален вызов safeDestroy() из on("error") — теперь Processor управляет жизненным циклом
  private setupEventHandlers(): void {
    this.on("error", (error) => {
      console.debug("[AudioProcessor] Error:", error?.message ?? error);
    });

    this.on("close", () => {
      console.debug("[AudioProcessor] Closed");
      this.isDestroyed = true;
    });

    this.on("finish", () => {
      console.debug("[AudioProcessor] Finished");
    });
  }

  // FIX: Безопасный destroy без рекурсии
  private safeDestroy(): void {
    if (this.isDestroyed || this.destroyed) return;
    this.isDestroyed = true;
    try {
      this.removeAllListeners();
      super.destroy();
    } catch (error) {
      console.debug("[AudioProcessor] Destroy error:", (error as Error).message);
    }
  }

  override destroy(error?: Error): this {
    if (this.isDestroyed) return this;
    this.isDestroyed = true;
    this.removeAllListeners();
    super.destroy(error);
    return this;
  }
}


