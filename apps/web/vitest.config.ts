import { defineConfig } from 'vitest/config';

// Unit tests of the web lib and shared components (rendered to static markup; no browser needed).
// The Playwright specs live in tests/ and run with `npm run test:e2e`.
export default defineConfig({
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
