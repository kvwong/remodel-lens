# Remodel Lens

Remodel Lens creates realistic listing-photo redesigns from your interior-taste
references. Each redesign is scoped to a budget tier and includes a report with
cost bands and checks for changes to fixed architecture. See [PLAN.md](PLAN.md)
for architecture and roadmap details.

## Get started

### Requirements

- Node.js 22 or newer and npm.
- API keys for OpenAI and Anthropic to use the default models. Image generation
  always uses OpenAI. You can start the local app without keys, but you need
  the required keys to rebuild taste rules or generate redesigns.

### Install and configure

From the repository root:

```bash
npm ci
cp .env.example .env.local
```

Open `.env.local` and add your keys:

```dotenv
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
```

The defaults use OpenAI and Anthropic for reference analysis, OpenAI for
planning and checks, and OpenAI for image edits. To use OpenAI for all analysis
and planning, set these optional overrides in `.env.local`:

```dotenv
ANALYSIS_MODELS=openai/gpt-6.1-sol
REASONING_MODEL=openai/gpt-6.1-sol
```

You can change model IDs and image concurrency with the optional settings in
[`.env.example`](.env.example). Keep real keys in `.env.local`; never commit
them.

### Start the app

```bash
npm run app
```

Open <http://localhost:4310>. To use another local port, set `PORT` before
starting the app, for example `PORT=4320 npm run app`.

## Create a taste profile

1. In **Taste profiles**, open **Example** or choose **New** to create a profile.
2. Add at least 3 interior reference photos you like; 10–20 gives the models
   more to work with. JPG, PNG, WebP, and TIFF are supported. Near-duplicates
   are skipped.
3. Write a brief describing your preferred styles, materials, colors, rooms,
   and things to avoid. Be specific about the materials and details you want.
4. Choose **Rebuild rules**. The app combines the brief with analysis of your
   references. You can then edit the rules, image direction, and room notes in
   the app.

The app saves the profile in `profiles/<id>/`. You can rebuild its rules from
the command line with:

```bash
npm run taste -- --profile example
```

## Add a listing

Import photos from a local folder. Replace the example path, ID, and name with
your own:

```bash
npm run import -- ~/Pictures/123-main-st --id 123-main-st --name "123 Main St"
```

The importer accepts JPG, PNG, WebP, and TIFF files, corrects photo rotation,
resizes large images, skips near-duplicates, and adds new photos as selected.
Reload the app to see the listing. You can also import individual files by
passing their paths instead of a folder. In the app, label rooms (for example,
`kitchen` or `den`), choose which photos to redesign, select a taste profile,
and choose the budget tiers.

Listings and their selections are stored in `listings/<id>/`. To add more
photos to an existing listing, run the import command again with the same ID.

## Generate a redesign

In the app, open the listing and choose **Run redesign**. The report opens when
the run finishes. Each room includes before-and-after images by tier, a change
list with cost bands, and a verification status.

You can also run the saved listing selection from the CLI:

```bash
npm run redesign -- listings/123-main-st --profile profiles/example/profile.json --tiers cosmetic,moderate
```

Add `major` to `--tiers` for speculative layout changes. Reports and run data
are saved under `.runs/`. API calls can incur charges; each run processes the
selected photos across the chosen tiers, and rebuilding a profile analyzes its
reference photos.

| Status | Meaning |
|---|---|
| Verified | Fixed elements (windows, doors, stairs, ceiling) passed both the edge check and the vision judge. |
| Needs review | The judge passed, but an edge shifted near a fixed element or the plan was only partly followed. |
| Unverified | Verification failed twice. Architecture changed; don't rely on the image for decisions. |

## Your data and privacy

Listings, profiles, reference photos, and run artifacts are stored in this
checkout. Personal listings, profiles, and runs are gitignored; only the empty
`profiles/example/` starter profile is shared in the repository. When you
rebuild rules or generate a redesign, the relevant reference or listing photos
and prompts are sent to the configured model providers for processing. Do not
use photos or details you are not comfortable sending to those providers.
Remodel Lens does not scrape listing sites; source listing photos yourself.

## Configuration

Settings are read from `.env.local` (preferred) or `.env` in the repository
root. `.env.example` lists the defaults:

| Setting | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for image edits and default OpenAI models. |
| `ANTHROPIC_API_KEY` | — | Required by the default analysis models. |
| `ANALYSIS_MODELS` | `openai/gpt-6.1-sol,anthropic/claude-sonnet-5-5` | Models that analyze each taste reference. |
| `REASONING_MODEL` | `openai/gpt-6.1-sol` | Planning, rule extraction, and verification. |
| `IMAGE_MODEL` | `gpt-image-2.5-sunburst` | Image-edit model. |
| `IMAGE_CONCURRENCY` | `4` | Maximum image edits in flight across listings. |
| `PORT` | `4310` | Local app port. |

## Development checks

```bash
npm run check
npm test
```
