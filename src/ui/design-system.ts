import { readFileSync } from "node:fs";

/** Embed once in each document, including standalone HTML report exports. */
export const designSystemStyles = readFileSync(new URL("./design-system.css", import.meta.url), "utf8");
