// Copyright 2026 The VeriHarness Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The deliverable check of a worker: a small JSON Schema validator. A value that parses is not yet a
 * deliverable; it has the shape the task asked for or it does not. The validator knows the keywords
 * below. `unsupportedKeywords` names any other keyword of a schema, so a schema is never passed by
 * having a part the validator skipped.
 */

type Json = unknown;
type Schema = Record<string, Json>;

/** Keywords that check a value. */
const CHECKING = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
]);
/** Keywords that only describe. */
const ANNOTATION = new Set(["$schema", "$id", "title", "description", "default", "examples"]);

const isObject = (v: Json): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON type name of a value. */
function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** `integer` is a number that is whole; every other type is the JSON type name. */
function matchesType(v: Json, want: string): boolean {
  if (want === "integer") return typeof v === "number" && Number.isInteger(v);
  return typeOf(v) === want;
}

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The errors of `value` against `schema`, one line each with the path of the value; empty when it fits. */
export function validateSchema(value: Json, schema: Json, path = "$"): string[] {
  if (!isObject(schema)) return [];
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? (schema.type as string[]) : [String(schema.type)];
    if (!wanted.some((w) => matchesType(value, w))) {
      return [`${path}: expected ${wanted.join(" or ")}, got ${typeOf(value)}`];
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
    errors.push(`${path}: not one of ${schema.enum.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(", ")}`);
  }
  if ("const" in schema && !same(schema.const, value)) errors.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((alt) => validateSchema(value, alt, path).length === 0)) {
      errors.push(`${path}: matches none of the ${schema.anyOf.length} alternatives`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: ${value} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: ${value} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items, fewer than ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items, more than ${schema.maxItems}`);
    }
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (!(key in value)) errors.push(`${path}: missing property '${key}'`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (key in props) errors.push(...validateSchema(v, props[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property '${key}'`);
      else if (isObject(schema.additionalProperties)) errors.push(...validateSchema(v, schema.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}

/** The keywords of `schema` the validator does not check, as `path: keyword`; empty when it checks them all. */
export function unsupportedKeywords(schema: Json, path = "$"): string[] {
  if (!isObject(schema)) return [];
  const out: string[] = [];
  for (const [key, v] of Object.entries(schema)) {
    if (!CHECKING.has(key) && !ANNOTATION.has(key)) out.push(`${path}: ${key}`);
    else if (key === "properties" && isObject(v)) {
      for (const [name, sub] of Object.entries(v)) out.push(...unsupportedKeywords(sub, `${path}.properties.${name}`));
    } else if (key === "items" || key === "additionalProperties") out.push(...unsupportedKeywords(v, `${path}.${key}`));
    else if (key === "anyOf" && Array.isArray(v)) v.forEach((sub, i) => out.push(...unsupportedKeywords(sub, `${path}.anyOf[${i}]`)));
  }
  return out;
}
