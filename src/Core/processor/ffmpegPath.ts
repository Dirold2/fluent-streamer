const FFMPEG_PACKAGE_CANDIDATES = ["ffmpeg-static", "@ffmpeg-installer/ffmpeg"] as const;

function isServer(): boolean {
  return typeof globalThis !== "undefined" && "process" in globalThis && !("window" in globalThis);
}

async function resolvePackageFfmpegPath(): Promise<string | null> {
  if (!isServer()) return null;

  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);

    for (const packageName of FFMPEG_PACKAGE_CANDIDATES) {
      try {
        const mod = require(packageName) as unknown;
        if (typeof mod === "string" && mod.length > 0) return mod;
        if (mod && typeof mod === "object") {
          const pathValue = (mod as { path?: unknown }).path;
          if (typeof pathValue === "string" && pathValue.length > 0) return pathValue;
        }
      } catch {
        //
      }
    }
  } catch {
    //
  }

  return null;
}

async function hasSystemFfmpeg(): Promise<boolean> {
  if (!isServer()) return false;

  try {
    if ("Bun" in globalThis) {
      return Bun.spawnSync(["ffmpeg", "-version"]).success;
    }

    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const cp = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      cp.on("error", () => resolve(false));
      cp.on("close", (code) => resolve(code === 0));
    });
  } catch {
    return false;
  }
}

export async function resolveFfmpegPath(explicitPath?: string): Promise<string> {
  const requestedPath = explicitPath?.trim();
  if (requestedPath && requestedPath !== "ffmpeg") return explicitPath!;

  const packagePath = await resolvePackageFfmpegPath();
  if (packagePath) return packagePath;

  if (await hasSystemFfmpeg()) return "ffmpeg";

  return requestedPath || "ffmpeg";
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (!isServer()) return false;
  return (await resolvePackageFfmpegPath()) !== null || (await hasSystemFfmpeg());
}
