import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), "../templates/plugin");

/** Copies the canonical template into targetDir without overwriting author work. */
export async function create(targetDir) {
  if (!existsSync(TEMPLATE)) throw new Error(`create: missing template directory ${TEMPLATE}`);
  const target = resolve(targetDir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`create: target directory is not empty: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE, target, { recursive: true });
  // The manifest id is what the dev form in the host and `pack` ask for.
  const manifest = JSON.parse(readFileSync(resolve(target, "manifest.json"), "utf8"));
  return { dir: target, id: manifest.id };
}
