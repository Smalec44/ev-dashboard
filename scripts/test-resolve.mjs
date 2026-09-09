/**
 * Lets `node --test` import the "@/…" paths the app uses.
 *
 * tsconfig maps "@/*" to "./src/*", and Next resolves it at build time — but
 * node knows nothing about tsconfig, so every module using the alias was
 * simply untestable and the suite had grown up around that limit. This maps
 * the alias the same way tsconfig does, and appends the ".ts" extension that
 * node's type stripping requires and TypeScript's resolver does not.
 *
 * Loaded via `node --import ./scripts/test-resolve.mjs` in the test script.
 */
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const url = new URL(specifier.slice(2), SRC);
    if (!/\.\w+$/.test(url.pathname)) url.pathname += ".ts";
    return nextResolve(url.href, context);
  },
});
