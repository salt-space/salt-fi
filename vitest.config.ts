import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app uses NodeNext-style `.js` import specifiers that point at `.ts`
  // sources (tsx/tsc resolve these natively; Vite does not). Map `.js` -> `.ts`
  // so `import { x } from "../src/foo.js"` resolves in tests too.
  resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Integration tests hit the live testnet API over the network and share
    // testnet state (one org, one robo host), so give them room and run serially.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
