import { describe, it, expect, beforeEach } from "vitest";
import { resolveObjectURL } from "buffer";
import FluentStream from "../src/Core/FluentStream.js";

describe("Blob URL support", () => {
  let stream: FluentStream;

  beforeEach(() => {
    stream = new FluentStream();
  });

  it("принимает blob URL через input метод", () => {
    const blobUrl = "blob:nodedata:3e5ef187-6438-4a3a-bf45-a11b6406f6f8";
    stream.input(blobUrl);
    
    console.log(stream.getArgs)
    expect(stream.getArgs()).toEqual(["-i", "pipe:0"]);
  });

  it("формирует правильные FFmpeg аргументы для blob", () => {
    const blobUrl = "blob:nodedata:test-uuid";
    stream.input(blobUrl).format("mp3").output("output.mp3");
    expect(stream.getArgs()).toEqual(["-i", "pipe:0", "-f", "mp3", "output.mp3"]);
  });

  it("возвращает undefined для blob URL в Node.js среде", () => {
    const blobUrl = "blob:nodedata:5f243e10-c206-46c2-83fc-6ee018f80508";
    const result = resolveObjectURL(blobUrl);
    expect(result).toBeUndefined();
  });

  it("принимает различные форматы blob URL", () => {
    const testUrls = [
      "blob:test",
      "blob:nodedata:some-uuid",
      "blob:audio-data:12345",
      "blob:nodedata:5f243e10-c206-46c2-83fc-6ee018f80508"
    ];

    for (const url of testUrls) {
      const testStream = new FluentStream();
      expect(() => testStream.input(url)).not.toThrow();
      expect(testStream.getArgs()).toEqual(["-i", "pipe:0"]);
    }
  });

  it("inputBlob метод работает с тем же результатом", () => {
    const blobUrl = "blob:nodedata:test-blob";
    stream.inputBlob(blobUrl);
    expect(stream.getArgs()).toEqual(["-i", "pipe:0"]);
  });

  it("blob URL обрабатывается как input source", () => {
    const blobUrl = "blob:nodedata:test-blob";
    stream.input(blobUrl);
    // Проверяем что blob URL добавлен в input sources через приватное API
    expect(stream.getArgs()).toEqual(["-i", "pipe:0"]);
  });

  it("inputBlob выбрасывает ошибку для пустой строки", () => {
    expect(() => stream.inputBlob("")).toThrow("inputBlob(): blobUrl must be a non-empty string");
  });

  it("inputBlob выбрасывает ошибку для null", () => {
    expect(() => stream.inputBlob(null as any)).toThrow("inputBlob(): blobUrl must be a non-empty string");
  });

  it("inputBlob выбрасывает ошибку для undefined", () => {
    expect(() => stream.inputBlob(undefined as any)).toThrow("inputBlob(): blobUrl must be a non-empty string");
  });
});
