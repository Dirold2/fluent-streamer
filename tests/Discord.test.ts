import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Transform } from "stream";
import { EventEmitter } from "events";
import FluentStream from "../src/Core/FluentStream.js";

const AUDIO_TEST_URL = "https://strm-spbmiran-22.strm.yandex.net/music-v2/raw/ysign1=557a0d33abe5a398353e6825a2cd287a76880216a4e83e8053580c5a03da2dbd,lid=268,pfx,secret_version=ver-1,sfx,source=mds,ts=6902a135/0/51261/bf4f6ea7.204480811.7.139929546/320.mp3";
class AudioService extends EventEmitter {
  public ffmpeg?: InstanceType<typeof FluentStream>;
  public currentOptions: { volume: number; bass: number; headers?: Record<string, string> } = { volume: 0.5, bass: 1.0 };
  public pipelineReady = false;

  async createAudioStreamForDiscord(
    url: string,
    options?: Partial<{ volume: number; bass: number; headers?: Record<string, string> }>
  ): Promise<{ stream: Transform; type: string }> {
    if (options) Object.assign(this.currentOptions, options);
    const filters = [`volume=${this.currentOptions.volume}`];

    // Очищаем предыдущий процесс, если он был
    await this.destroy();

    this.pipelineReady = false;
    if (this.ffmpeg) this.ffmpeg.clear();

    const fluent = new FluentStream();

    // Устанавливаем заголовки, если заданы
    if (this.currentOptions.headers && Object.keys(this.currentOptions.headers).length > 0) {
      fluent.setHeaders(this.currentOptions.headers);
      fluent.headers(this.currentOptions.headers);
    }

    fluent
      .input(url)
      .inputOptions(
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-probesize", "32",
        "-analyzeduration", "0"
      )
      .audioCodec("pcm_s16le")
      .outputOptions(
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-af", filters.join(',')
      )
      .output("pipe:1");

    this.ffmpeg = fluent;

    // Запуск процесса
    const { output, done } = fluent.run();

    done
      .then(() => {
        this.pipelineReady = true;
        this.emit("debug", `[AudioService] Stream finished for ${url}`);
      })
      .catch((err: Error) => this.emit("error", err));

    this.pipelineReady = true;
    this.emit("debug", `[AudioService] Stream created for ${url}`);

    return { stream: output as Transform, type: "raw" };
  }

  async destroy() {
    if (this.ffmpeg) {
      this.ffmpeg.removeAllListeners();
      this.ffmpeg.clear();
    }
  }
}

describe("AudioService / FluentStream integration", () => {
  let service: AudioService;

  beforeEach(() => {
    service = new AudioService();
    FluentStream._reset();
  });

  afterEach(async () => {
    await service.destroy();
    FluentStream._reset();
  });

  it("создаёт audio stream", async () => {
    const result = await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    expect(result).toHaveProperty("stream");
    expect(result.stream).toBeInstanceOf(Transform);
    expect(result.type).toBe("raw");
  });

  it("прокидывает headers в setHeaders/headers и хранит их", async () => {
    const headers = { Auth: "abc", X: "22" };
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL, { headers });
    if (service.ffmpeg) {
      expect(service.ffmpeg.getHeaders()).toStrictEqual(headers);
    }
  });

  it("применяет правильные inputOptions для Discord", async () => {
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    if (service.ffmpeg) {
      const args: string[] = service.ffmpeg.getArgs();
      expect(args).toContain("-fflags");
      expect(args).toContain("nobuffer");
      expect(args).toContain("-flags");
      expect(args).toContain("low_delay");
      expect(args).toContain("-probesize");
      expect(args).toContain("32");
      expect(args).toContain("-analyzeduration");
      expect(args).toContain("0");
    }
  });

  it("применяет правильные outputOptions с фильтром volume", async () => {
    const volume = 0.8;
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL, { volume });
    if (service.ffmpeg) {
      const args: string[] = service.ffmpeg.getArgs();
      expect(args).toContain("-f");
      expect(args).toContain("s16le");
      expect(args).toContain("-ar");
      expect(args).toContain("48000");
      expect(args).toContain("-ac");
      expect(args).toContain("2");
      expect(args).toContain("-af");
      const afIndex = args.indexOf("-af");
      expect(args[afIndex + 1]).toContain(`volume=${volume}`);
    }
  });

  it("устанавливает аудиокодек pcm_s16le", async () => {
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    if (service.ffmpeg) {
      const args: string[] = service.ffmpeg.getArgs();
      expect(args).toContain("-c:a");
      expect(args).toContain("pcm_s16le");
    }
  });

  it("очищает предыдущий процесс при повторном вызове", async () => {
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    const firstFfmpeg = service.ffmpeg;
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    const secondFfmpeg = service.ffmpeg;
    expect(firstFfmpeg).not.toBe(secondFfmpeg);
  });

  it("обновляет currentOptions при передаче options", async () => {
    const newOptions = { volume: 0.3, bass: 2.5 };
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL, newOptions);
    expect(service.currentOptions.volume).toBe(0.3);
    expect(service.currentOptions.bass).toBe(2.5);
  });
});
