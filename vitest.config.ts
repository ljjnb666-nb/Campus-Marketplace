import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/**/*.test.*", "src/**/*.d.ts", "src/types/**"],
      thresholds: {
        // 实测(2026-08-21): lines/statements 86.94 / branches 80.04 / functions 81.24，
        // 统一提升至 80 门槛（用户路线图目标），后续只升不降。
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
