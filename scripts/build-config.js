import { fileURLToPath } from "node:url";

export const bundleOptions = {
  entryPoints: [fileURLToPath(new URL("../src/apps-script.js", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "CibusBot",
  platform: "browser",
  inject: [fileURLToPath(new URL("../src/encoding.js", import.meta.url))],
  target: "es2020",
  legalComments: "inline",
};
