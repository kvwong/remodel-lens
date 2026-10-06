# Whim: implementation plan

Goal: take listing photos (Redfin, Zillow, MLS), redesign the interiors to match
your taste, and keep every redesign realistic enough to use when deciding whether
a house is worth remodeling.

The architecture follows [jaytel0/taste](https://github.com/jaytel0/taste):
two vision models analyze each image, a third merges their notes without knowing
which model wrote which, and the merged notes are condensed into firm rules.
That repo has no license, so none of its code is copied. Its prompts were also
built for UI and graphic design and tell the model to ignore depicted objects.
For interiors, those objects (furniture, finishes, fixtures) are the taste, so
every prompt here is new.

## Pipeline

```
reference photos ──► [1] Taste profile ──► taste-profile.json
                                                  │
listing photos ──► [2] Room inventory ──┐         │
                     (fixed vs changeable,        │
                      bounding boxes)             │
                                        ▼         ▼
                               [3] Change plan, per tier
                                   (cosmetic / moderate / major)
                                        │
                                        ▼
                               [4] Masked image edit (gpt-image)
                                        │
                                        ▼
                               [5] Verify geometry ──fail──► retry once
                                   (edge match in fixed areas
                                    + vision judge)
                                        │
                                        ▼
                               [6] report.html (before/after,
                                   change list, cost bands, flags)
```

### 1. Taste profile (`src/taste/`)
- About 10–20 interior reference photos. Close crops of materials and details help.
- GPT and Claude each analyze every image, covering palette, materials and
  finishes, cabinetry and millwork, flooring, lighting, furniture shapes, how
  full or sparse the room is, era, and what to avoid.
- One model merges the two analyses per image. The analyses are anonymized and
  the merging model looks at the image again.
- Notes are processed in chunks of up to 10, each producing concrete rules.
  Each rule records how many images support it.
- The final output is a **structured JSON `TasteProfile`** (zod schema), not a
  prose skill file. A readable `taste-profile.md` is rendered alongside it.
- Rules with low support (backed by only 1–2 images) are kept but flagged.
  Later steps weight them lower, so one striking photo can't take over the profile.

### 2. Room inventory (`src/listing/`)
For each listing photo, a vision model returns:
- **Fixed** elements: windows, doors, doorways, ceiling plane and height cues,
  beams, stairs, fireplace, exterior walls, radiators, and likely plumbing
  locations. Each has a bounding box.
- **Changeable** elements, each with a description of what's there now, a
  bounding box, and the lowest tier that can change it.
- Uncertainties: walls that might be load-bearing, partial views.

Boxes are normalized to 0–1000. GPT and Claude produce rough boxes, so masks are
padded and verification doesn't rely on exact pixel edges.

### 3. Tiers and change plan (`src/redesign/tiers.ts`, `plan.ts`)
| Tier | Allowed | Meaning |
|---|---|---|
| cosmetic | paint, light fixtures in the same location, furniture, decor, window treatments, hardware, refinishing existing floors | Good evidence |
| moderate | + new flooring, cabinets and counters in the same layout, backsplash and tile, plumbing fixtures in the same location, trim and interior doors | Good evidence, real budget |
| major | + removing non-load-bearing walls, moving plumbing, new layouts | Speculative, needs a contractor or engineer |

The planner combines the inventory and the taste profile into a list of changes:
element → proposed change, tier, installed cost range, and notes. It also
lists what must stay untouched. It can only change elements the tier allows.

### 4. Generation (`src/redesign/generate.ts`, `mask.ts`)
- The mask covers the changeable boxes allowed at this tier. Fixed boxes are
  always opaque (protected) and win wherever they overlap.
- The prompt is built from the change plan: an explicit preservation list (same
  camera, lens, perspective and openings), only the planned changes, and the
  taste rules that apply.
- OpenAI `images.edit` uses `gpt-image-2.5-sunburst` by default (configurable).
  In testing (2026-10-03), the 2.5 models filled any alpha-masked area with
  black but scoped edits precisely without a mask, so they get prompt-only
  edits. `gpt-image-2` and older still get the mask, but treat it as guidance
  and rebuilt the whole masked area. Either way, step 5 is the safety net.

### 5. Verification (`src/redesign/verify.ts`)
- **Edge match:** a Sobel edge map of the original vs. the redesign, correlated
  inside each fixed box (sharp only, no OpenCV). Low correlation means a window
  or doorway moved.
- **Vision judge:** compares both images and checks each fixed element. Was it
  preserved? Were openings added or removed? Did the plan get followed?
- Fails trigger one retry with the failure fed back into the prompt. A second
  failure is kept but labeled "unverified".

### 6. Report (`src/report.ts`)
A static HTML page per listing: before/after per tier, the change list with cost
bands, verification results, and feasibility flags.

## Phases
1. **CLI core (this build):** steps 1–6 as two commands, `npm run taste` and
   `npm run redesign`. Local files only, with outputs in `.runs/`.
2. **Tune with real photos:** test on 3–5 real listings. Adjust inventory
   prompts and the edge-match threshold. Compare `gpt-image-2` with the
   `gpt-image-2.5-*` models. `npm run tune` scores past runs, sweeps the
   threshold, and compares image models (`npm run tune -- compare`).
3. **Stricter structure preservation if needed:** if masked gpt-image edits keep
   drifting, add a Flux/SDXL + ControlNet (depth and straight-line) backend
   through Replicate or fal behind the same `generate` interface.
4. **Cost model:** price changes from a unit-cost table (`src/pricing/`) instead of
   the model's guess. The planner picks a table item, measures the quantity, and
   names a material grade; the code multiplies by Homewyse national unit costs,
   adjusted for local construction wages (BLS; Seattle and the Eastside so far),
   grade, and contractor overhead. Items with no table entry (furniture,
   appliances, wall removal) keep the model's estimate and are labeled as such.
   Next: calibrate against real local quotes when there are some.
5. **Web UI:** upload a listing, view tiers side by side, tweak the taste profile.

## Out of scope / notes
- No scraping. Zillow and Redfin terms prohibit it and listing photos are
  copyrighted. Download or screenshot photos yourself, for personal use.
- The app never states that a wall is load-bearing. Major-tier output always
  says it needs professional verification.
