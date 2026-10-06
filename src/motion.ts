import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// Keep reports opened from disk self-contained, and serve the same bundle in the app.
const motionBundle = new URL("./dist/motion.js", pathToFileURL(require.resolve("motion/package.json")));
export const motionScript = `${readFileSync(motionBundle, "utf8")}\n${readFileSync(new URL("./app/motion.js", import.meta.url), "utf8")}`;
