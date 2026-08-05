// Preloaded by bunfig.toml when someone runs `bun test`. This project's tests
// need vitest's jsdom environment and vi APIs, which Bun's runner doesn't
// provide — fail fast with a pointer to the right command.
throw new Error("This project's tests run on vitest, not Bun's test runner. Use `bun run test` instead of `bun test`.");
