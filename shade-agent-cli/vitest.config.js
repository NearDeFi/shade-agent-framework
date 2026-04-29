import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.js"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/cli.js",
        "src/commands/auth/**",
        "src/commands/plan/**",
        "src/commands/whitelist/**",
        "src/commands/reproduce/**",
        "**/*.test.js",
        "**/tests/**",
      ],
    },
  },
});
