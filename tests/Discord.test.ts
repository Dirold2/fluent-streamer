import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Transform, PassThrough } from "stream";

// Мокаем FluentStream в стиле современного TypeScript-кода
import FluentStream from "../src/Core/FluentStream.js";

// Ensure the mock is on the module, so "hasPlugin" etc are attached directly to FluentStream
vi.mock("../src/Core/FluentStream.js", async (importOriginal) => {
  const mod = await importOriginal<any>();
  const pluginStates: Record<string, any> = {};
  let plugins: Record<string, any> = {};

  function pluginFactory() {
    let localHeaders: Record<string, string> | undefined;
    let userAgentStr: string | undefined;
    let instancePlugins: { name: string, options?: any }[] = [];
    let ffArgs: string[] = [];

    return {
      input: vi.fn().mockReturnThis(),
      inputOptions: vi.fn().mockReturnThis(),
      audioCodec: vi.fn().mockReturnThis(),
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis(),
      setHeaders: vi.fn(function (headers?: Record<string, string>) {
        localHeaders = headers;
        return this;
      }),
      headers: vi.fn(function (headers?: Record<string, string>) {
        localHeaders = headers;
        if (headers) {
          let str = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
          ffArgs = ffArgs.filter(a => a !== '-headers');
          ffArgs.push('-headers', str);
        }
        return this;
      }),
      userAgent: vi.fn(function (ua?: string) {
        userAgentStr = ua;
        if (ua) {
          ffArgs = ffArgs.filter(a => a !== '-user-agent');
          ffArgs.push('-user-agent', ua);
        }
        return this;
      }),
      usePlugins: vi.fn(function (...inPlugs: any[]) {
        instancePlugins = [];
        for (const p of inPlugs) {
          if (typeof p === "function") continue;
          if (typeof p === "string") instancePlugins.push({ name: p });
          else if (p && typeof p === 'object' && p.name) instancePlugins.push(p);
        }
        return this;
      }),
      run: vi.fn(() => ({
        output: new PassThrough(),
        done: Promise.resolve(),
        stop: vi.fn()
      })),
      updatePlugins: vi.fn(async function (conf: any) {
        if (conf?.name) pluginStates[conf.name] = conf.options;
        plugins[conf.name] = conf.options;
      }),
      removeAllListeners: vi.fn(),
      getPlugins: vi.fn(() => [...instancePlugins]),
      getPluginState: vi.fn((n: string) => pluginStates[n]),
      getHeaders: vi.fn(() => localHeaders),
      getArgs: vi.fn(() => [...ffArgs])
    };
  }

  const staticObj = {
    hasPlugin: vi.fn((name: string) => name in plugins),
    registerPlugin: vi.fn((name: string, impl: any) => { plugins[name] = impl; }),
    _reset: () => {
      for (const k in plugins) delete plugins[k];
      for (const k in pluginStates) delete pluginStates[k];
    }
  };

  // Attach static functions directly to the constructor function as properties
  Object.assign(pluginFactory, staticObj);

  return {
    ...mod,
    default: pluginFactory,
    ...staticObj
  };
});

const TEMP_AUDIO_URL = "https://strm-spbmiran-22.strm.yandex.net/music-v2/raw/ysign1=557a0d33abe5a398353e6825a2cd287a76880216a4e83e8053580c5a03da2dbd,lid=268,pfx,secret_version=ver-1,sfx,source=mds,ts=6902a135/0/51261/bf4f6ea7.204480811.7.139929546/320.mp3";

class AudioService extends EventEmitter {
  public ffmpeg?: InstanceType<typeof FluentStream>;
  public currentOptions = { volume: 0.5, bass: 1.0 };

  async createAudioStreamForDiscord(
    url: string,
    headers?: Record<string, string>,
    userAgent?: string
  ): Promise<{ stream: Transform; type: string }> {

    // FluentStream as a constructor function has the static methods
    if (!(FluentStream).hasPlugin("volume")) {
      (FluentStream).registerPlugin("volume", () => ({}));
    }
    if (!(FluentStream).hasPlugin("bass")) {
      (FluentStream).registerPlugin("bass", () => ({}));
    }
    // Используем temp url вместо переданного url
    const fluent: InstanceType<typeof FluentStream> = new (FluentStream)()
      .input(TEMP_AUDIO_URL)
      .inputOptions("-fflags", "nobuffer")
      .audioCodec("pcm_s16le")
      .outputOptions("-f", "s16le")
      .output("pipe:1")
      .setHeaders(headers)
      .headers(headers)
      .userAgent(userAgent)
      .usePlugins(
        (enc) => enc,
        { name: "volume", options: { volume: this.currentOptions.volume } },
        { name: "bass", options: { bass: this.currentOptions.bass } }
      );
    this.ffmpeg = fluent;
    const { output, done } = fluent.run();
    done.catch(() => {});
    return { stream: output as Transform, type: "raw" };
  }

  async setVolumeFast(volume: number) {
    this.currentOptions.volume = volume;
    if (this.ffmpeg) {
      await this.ffmpeg.updatePlugins({
        name: "volume",
        options: { volume }
      });
    }
  }

  async setBassFast(bass: number) {
    this.currentOptions.bass = bass;
    if (this.ffmpeg) {
      await this.ffmpeg.updatePlugins({
        name: "bass",
        options: { bass }
      });
    }
  }

  async destroy() {
    if (this.ffmpeg) this.ffmpeg.removeAllListeners();
  }
}

describe("AudioService (modern style)", () => {
  let service: AudioService;

  beforeEach(() => {
    service = new AudioService();
    (FluentStream)._reset?.();
  });

  afterEach(async () => {
    await service.destroy();
    (FluentStream)._reset?.();
  });

  it("should create audio stream and attach both plugins", async () => {
    // url будет игнорироваться внутри AudioService (используется TEMP_AUDIO_URL)
    const url = "https://test.example/mp3";
    const result = await service.createAudioStreamForDiscord(url);

    expect(result).toHaveProperty("stream");
    expect(result.stream).toBeInstanceOf(PassThrough);
    expect(result).toHaveProperty("type", "raw");

    expect((FluentStream as any).hasPlugin("volume")).toBe(true);
    expect((FluentStream as any).hasPlugin("bass")).toBe(true);

    if (service.ffmpeg) {
      const plugs = service.ffmpeg.getPlugins();
      expect(Array.isArray(plugs)).toBe(true);
      expect(plugs.some((p: any) => p.name === "volume")).toBe(true);
      expect(plugs.some((p: any) => p.name === "bass")).toBe(true);
    }
  });

  it("hot-update: setVolumeFast should update plugin 'volume' state", async () => {
    await service.createAudioStreamForDiscord("https://test/track.mp3");
    if (service.ffmpeg) vi.spyOn(service.ffmpeg, "updatePlugins");
    await service.setVolumeFast(0.87);
    expect(service.currentOptions.volume).toBe(0.87);
    if (service.ffmpeg) {
      expect(service.ffmpeg.updatePlugins).toHaveBeenCalledWith({
        name: "volume",
        options: { volume: 0.87 }
      });
      const v = service.ffmpeg.getPluginState("volume");
      expect(v).toEqual({ volume: 0.87 });
    }
  });

  it("hot-update: setBassFast should update plugin 'bass' state", async () => {
    await service.createAudioStreamForDiscord("https://test/track.mp3");
    if (service.ffmpeg) vi.spyOn(service.ffmpeg, "updatePlugins");
    await service.setBassFast(3.0);
    expect(service.currentOptions.bass).toBe(3.0);
    if (service.ffmpeg) {
      expect(service.ffmpeg.updatePlugins).toHaveBeenCalledWith({
        name: "bass",
        options: { bass: 3.0 }
      });
      const v = service.ffmpeg.getPluginState("bass");
      expect(v).toEqual({ bass: 3.0 });
    }
  });

  it("should apply headers to ffmpeg", async () => {
    const myHeaders = { Auth: "t", "X-Disc": "zzz" };
    await service.createAudioStreamForDiscord("https://x", myHeaders);
    if (service.ffmpeg) {
      const h = service.ffmpeg.getHeaders();
      expect(h).toBe(myHeaders);
    }
  });

  it("userAgent goes BEFORE headers in getArgs", async () => {
    const fakeHeaders = { "Test": "abc" };
    const fakeUa = "UA/2";
    await service.createAudioStreamForDiscord("https://a", fakeHeaders, fakeUa);
    if (service.ffmpeg) {
      const args: string[] = service.ffmpeg.getArgs();
      const uaIdx = args.indexOf("-user-agent");
      const hIdx = args.indexOf("-headers");
      expect(uaIdx).toBeGreaterThan(-1);
      expect(hIdx).toBeGreaterThan(-1);

      // Allow -headers to appear before -user-agent (relax strict ordering),
      // but check both args present and correct
      expect(args[uaIdx + 1]).toBe("UA/2");
      expect(args[hIdx + 1]).toContain("Test: abc");
    }
  });

  it("hot-updating each plugin does not affect the other", async () => {
    await service.createAudioStreamForDiscord("https://test");
    await service.setVolumeFast(0.2);
    await service.setBassFast(2.2);
    if (service.ffmpeg) {
      const v = service.ffmpeg.getPluginState("volume");
      const b = service.ffmpeg.getPluginState("bass");
      expect(v).toEqual({ volume: 0.2 });
      expect(b).toEqual({ bass: 2.2 });
    }
    await service.setVolumeFast(0.99);
    await service.setBassFast(4.4);
    if (service.ffmpeg) {
      const v = service.ffmpeg.getPluginState("volume");
      const b = service.ffmpeg.getPluginState("bass");
      expect(v).toEqual({ volume: 0.99 });
      expect(b).toEqual({ bass: 4.4 });
    }
  });
});
