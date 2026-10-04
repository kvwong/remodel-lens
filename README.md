# Remodel Lens

Redesign listing photos to match your interior taste, with each redesign limited
to what a realistic remodel at a given budget tier could do. See
[PLAN.md](PLAN.md) for the architecture and roadmap.

## Setup

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY and ANTHROPIC_API_KEY
```

You need your own API keys: an OpenAI key (image edits and analysis) and an
Anthropic key (the second analysis model). To use only one provider, set
`ANALYSIS_MODELS` and `REASONING_MODEL` (see Config).

The repo ships with no taste. It includes an empty `profiles/example/` profile
to start from. Your profiles, reference photos, listings, and runs stay local
and are gitignored.

## 1. Taste profiles

Profiles live in `profiles/<id>/`, each with its own reference photos, written
brief, and rules. To make your own, open **Example** (or click **New…**), add
10–20 interior photos you like, write a brief, and click **Rebuild rules**. Manage them in the app (`npm run app` → **Taste profiles**):

- **References:** add photos (drag and drop, JPG/PNG/WebP/TIFF; duplicates are
  refused) or remove them, with Undo.
- **Brief:** describe the taste in your own words. Rebuilds treat it as the
  strongest signal.
- **Rules:** edit, add, or delete individual rules, the image direction, and
  room notes.
- **Rebuild rules:** GPT and Claude analyze every reference and merge the
  results with the brief. The previous rules are kept and can be restored. The
  app shows when photos or the brief have changed since the last build.
- **New…:** start empty or from a copy of an existing profile.

The same rebuild is available from the CLI:

```bash
npm run taste -- --profile example
```

## 2. Pick photos

Save each listing's photos into a folder, e.g. `listings/123-main-st/`. Then run:

```bash
npm run app
```

Open http://localhost:4310. For each listing you can choose which photos to
redesign, label each room ("great room", "den") so the right taste direction
applies, pick tiers and a profile, and run. Selections save to
`listings/<id>/listing.json`, and past runs link to their reports. An optional
`name` in listing.json sets the display name.

## 3. Redesign a listing

From the app, or from the CLI using the same saved selection:

```bash
npm run redesign -- listings/123-main-st --profile profiles/example/profile.json --tiers cosmetic,moderate
```

Add `major` to `--tiers` for speculative layout changes. Open the printed
`report.html` to see before/after images per tier, the change list with cost
bands, and each image's verification status:

| Status | Meaning |
|---|---|
| Verified | Fixed elements (windows, doors, stairs, ceiling) passed both the edge check and the vision judge |
| Needs review | The judge passed it, but edge structure shifted near a fixed element, or the plan was only partly followed |
| Unverified | Failed twice. Architecture changed, so don't trust it for decisions |

## Config

| Env var | Default |
|---|---|
| `ANALYSIS_MODELS` | `openai/gpt-6.1-sol,anthropic/claude-sonnet-5-5` |
| `REASONING_MODEL` | `openai/gpt-6.1-sol` |
| `IMAGE_MODEL` | `gpt-image-2.5-sunburst` (prompt-only edits; older models get the mask) |
| `IMAGE_CONCURRENCY` | `4` (shared across listings running in parallel) |

## Checks

```bash
npm run check && npm test
```

Download listing photos yourself, for personal use. This tool doesn't scrape listing sites.
