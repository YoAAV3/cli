import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../builds/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../dist/spicy-lyrics.js", import.meta.url),
  new URL("../builds/spicy-lyrics.mjs", import.meta.url),
);
