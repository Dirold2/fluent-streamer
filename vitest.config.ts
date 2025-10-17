import { defineConfig } from 'vitest/config'
import { config as loadEnv } from 'dotenv'

// Load environment variables from .env at project root
loadEnv({ path: '.env' })

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      'src': '/home/dirold2/dev/git/ffmpeg-streamer/src',
    },
  },
})


