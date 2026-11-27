#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The contracts validator is TypeScript with NodeNext ".js" specifiers.
// Native type stripping runs the sources as-is; this hook only maps those
// specifiers back to ".ts" so `npx vibe-plugin` needs no bundler or loader dep.
const TS_RESOLVER = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(TS_RESOLVER)}`);

// Dynamic imports run after the hook is registered; static ones would be hoisted.
const { create } = await import("./create.mjs");
const { pack, injectBoot } = await import("./pack.mjs");
const { check } = await import("./check.mjs");

export { create, injectBoot, pack, check };

function usage() {
  console.error("Usage: vibe-plugin <create|pack|check> [path]");
  process.exitCode = 2;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    if (args.length !== 1) return usage();
    const created = await create(args[0]);
    console.log(`created ${created.dir}`);
    console.log(`plugin id: ${created.id} — enter it in the host's "Разработка" section to run with HMR`);
  } else if (command === "pack") {
    console.log(await pack(args[0] ?? process.cwd()));
  } else if (command === "check") {
    if (args.length !== 1) return usage();
    const result = await check(args[0]);
    if (!result.ok) {
      for (const error of result.errors) console.error(`error: ${error}`);
      process.exitCode = 1;
    } else {
      console.log("ok");
    }
  } else {
    usage();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
