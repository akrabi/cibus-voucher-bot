import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { bundleOptions } from "./build-config.js";

await mkdir("dist", { recursive: true });
await build({
  ...bundleOptions,
  outfile: "dist/bundle.js",
});
await copyFile("src/appsscript.json", "dist/appsscript.json");
await writeFile("dist/entrypoints.js", [
  "function runImport() { return CibusBot.runImport(); }",
  "function previewImport() { return CibusBot.previewImport(); }",
  "function enableSchedule() { return CibusBot.enableSchedule(); }",
  "function disableSchedule() { return CibusBot.disableSchedule(); }",
].join("\n") + "\n");
