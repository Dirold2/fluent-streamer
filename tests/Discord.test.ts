import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough, Transform } from "stream";
import { EventEmitter } from "events";
import FluentStream from "../src/Core/FluentStream.js";

const AUDIO_TEST_URL = "https://strm-spbmiran-22.strm.yandex.net/music-v2/raw/ysign1=557a0d33abe5a398353e6825a2cd287a76880216a4e83e8053580c5a03da2dbd,lid=268,pfx,secret_version=ver-1,sfx,source=mds,ts=6902a135/0/51261/bf4f6ea7.204480811.7.139929546/320.mp3";
class AudioService extends EventEmitter {
  public ffmpeg?: InstanceType<typeof FluentStream>;
  public currentOptions = { volume: 0.5, bass: 1.0 };

  async createAudioStreamForDiscord(
    url: string,
    headers?: Record<string, string>,
    userAgent?: string
  ): Promise<{ stream: Transform; type: string }> {
    const fluent = new (FluentStream)()
      .input(url)
      .inputOptions("-fflags", "nobuffer")
      .audioCodec("pcm_s16le")
      .outputOptions("-f", "s16le")
      .output("pipe:1")
      .setHeaders(headers)
      .headers(headers)
      .userAgent(userAgent)
    this.ffmpeg = fluent;
    const { output, done } = fluent.run();
    done.catch(() => {});
    return { stream: output as Transform, type: "raw" };
  }
  async destroy() {
    if (this.ffmpeg) (this.ffmpeg).removeAllListeners();
  }
}

describe("AudioService / FluentStream integration", () => {
  let service: AudioService;

  beforeEach(() => {
    service = new AudioService();
    (FluentStream as any)._reset();
  });

  afterEach(async () => {
    await service.destroy();
    (FluentStream as any)._reset();
  });

  it("создаёт audio stream", async () => {
    const result = await service.createAudioStreamForDiscord(AUDIO_TEST_URL);
    expect(result).toHaveProperty("stream");
    expect(result.stream).toBeInstanceOf(PassThrough);
    expect(result.type).toBe("raw");
  });

  it("прокидывает headers в setHeaders/headers и хранит их", async () => {
    const headers = { Auth: "abc", X: "22" };
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL, headers);
    if (service.ffmpeg) {
      expect(service.ffmpeg.getHeaders()).toStrictEqual(headers);
    }
  });

  it("userAgent добавляет соответствующий аргумент до -headers", async () => {
    const headers = { Z: "1" };
    const ua = "YandexBot/23";
    await service.createAudioStreamForDiscord(AUDIO_TEST_URL, headers, ua);
    if (service.ffmpeg) {
      const args: string[] = service.ffmpeg.getArgs();
      const uIdx = args.indexOf("-user_agent");
      const hIdx = args.indexOf("-headers");
      expect(uIdx).toBeGreaterThan(-1);
      expect(hIdx).toBeGreaterThan(-1);
      expect(args[uIdx + 1]).toBe(ua);
      expect(args[hIdx + 1]).toContain("Z: 1");
    }
  });
});
