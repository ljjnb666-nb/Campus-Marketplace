import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: ["src/**/*.test.*", "src/**/*.d.ts", "src/types/**"],
      thresholds: {
        // 实测基线(2026-08-17):lines 66.06 / branches 69.27 / functions 61.95 / statements 66.06,
        // 门槛按实测值留约 3 个点缓冲设置,只升不降。
        lines: 63,
        branches: 66,
        functions: 59,
        statements: 63,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
