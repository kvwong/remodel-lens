#!/usr/bin/env node
// Usage: npm run scrape -- "<Redfin/Zillow/Compass link or street address>" [--name "Display Name"] [--id <existing-listing>] [--dry-run]
// Creates a listing from the page's photos (or adds them to --id). --dry-run only lists the photo URLs it found.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { log } from "../files.js";
import { addPhotosFromWeb, createListingFromWeb, listingDir } from "../listing/listing.js";
import { scrapeListing, SITE_NAMES } from "../listing/scrape.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, name: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const link = positionals.join(" ").trim();
  if (!link) throw new Error('Usage: npm run scrape -- "<listing link or address>" [--name "Name"] [--id <listing-id>] [--dry-run]');

  if (values["dry-run"]) {
    const page = await scrapeListing(link);
    log(`${SITE_NAMES[page.site]}: ${page.url}`);
    log(`Address: ${[page.street, page.locality].filter(Boolean).join(", ") || "not found"}`);
    page.photos.forEach((photo, i) => log(`${String(i + 1).padStart(2)}  ${photo.candidates[0]}`));
    log(`${page.photos.length} photos found${page.refused.length ? ` (${page.refused.join("; ")})` : ""}`);
    return;
  }

  const result = values.id
    ? await (async () => {
        const dir = listingDir(values.id!);
        if (!existsSync(dir)) throw new Error(`No listing "${values.id}".`);
        return addPhotosFromWeb(dir, await scrapeListing(link));
      })()
    : await createListingFromWeb({ link, name: values.name });
  log(`${result.listing.id}: added ${result.added} of ${result.found} photos from ${result.site} (${result.skipped} duplicates, ${result.failed} failed), ${result.listing.photos.length} total`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
