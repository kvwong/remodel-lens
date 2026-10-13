import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import type { z } from "zod";
import { JudgeResult } from "../src/redesign/verify.js";
import { RoomInventory } from "../src/listing/inventory.js";
import { ChangePlan } from "../src/redesign/plan.js";
import { TasteProfile } from "../src/taste/schema.js";
import { PinChecks } from "../src/redesign/change.js";
import { PhotoSort } from "../src/listing/sort.js";

/** OpenAI's structured output wants every property listed in `required`; a .default() or .optional() drops one and the whole call fails. */
function missingRequired(node: unknown, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  const schema = node as Record<string, unknown>;
  const problems: string[] = [];
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties) {
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of Object.keys(properties)) if (!required.includes(key)) problems.push(`${path}.${key}`);
    for (const [key, child] of Object.entries(properties)) problems.push(...missingRequired(child, `${path}.${key}`));
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
    const child = schema[key];
    if (Array.isArray(child)) child.forEach((c, i) => problems.push(...missingRequired(c, `${path}.${key}[${i}]`)));
    else if (child && typeof child === "object") {
      if (key === "items") problems.push(...missingRequired(child, `${path}[]`));
      else for (const [name, c] of Object.entries(child)) problems.push(...missingRequired(c, `${path}.${key}.${name}`));
    }
  }
  return problems;
}

const schemas: Record<string, z.ZodType> = { JudgeResult, RoomInventory, ChangePlan, TasteProfile, PinChecks, PhotoSort };

describe("structured output schemas", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} lists every property as required`, () => {
      expect(missingRequired(zodSchema(schema).jsonSchema)).toEqual([]);
    });
  }
});
