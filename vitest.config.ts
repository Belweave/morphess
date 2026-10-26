import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], maxWorkers: 2, testTimeout: 20_000, hookTimeout: 20_000 },
});
