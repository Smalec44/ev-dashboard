/**
 * Lets `node --test` and the build script import the app's modules.
 *
 * Two things the bundler does that node will not: map "@/…" to ./src the way
 * tsconfig does, and accept an extensionless relative import ("./geo") of a
 * TypeScript file. Node's type stripping needs the ".ts" spelled out, so both
 * shapes get it appended — but only when the extensionless path does not
 * already name a real file, so a plain "./data.json" is left alone.
 *
 * Loaded via `node --import ./scripts/resolve-alias.mjs` by the test and
 * build:data scripts.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

function withExtension(url) {
  if (/\.\w+$/.test(url.pathname)) return url;
  const path = fileURLToPath(url);
  for (const extension of [".ts", ".tsx"]) {
    if (existsSync(path + extension)) {
      url.pathname += extension;
      return url;
    }
  }
  return url;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(withExtension(new URL(specifier.slice(2), SRC)).href, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      return nextResolve(withExtension(new URL(specifier, context.parentURL)).href, context);
    }
    return nextResolve(specifier, context);
  },
});
