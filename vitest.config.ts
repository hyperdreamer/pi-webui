import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pi-webui/workspace-tasks-domain": new URL("./src/shared/workspaceTasks.ts", import.meta.url).pathname,
    },
  },
  test: {
    // Run test files serially to avoid QA-observed resource/concurrency timeout flakiness.
    maxWorkers: 1,
    include: ["src/**/*.test.ts", "pi-webui-plugins/**/*.test.ts", "scripts/**/*.test.mjs", "optional-skills/**/*.test.mjs"],
  },
});
