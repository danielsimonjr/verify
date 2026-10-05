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
 * Reading parts of an Office Open XML package (.docx, .pptx, .xlsx): a part by path, and the
 * parts it points at through its relationships. Links are followed through the package's own
 * relationship files, never through the number in a file name.
 */

import { posix } from "node:path";
import type JSZip from "jszip";

import { type XNode, attr, childrenNamed, parseOrdered, rootOf } from "./xml.js";

export type Rel = { id: string; type: string; target: string };

/** The root element of a part, or undefined when the package has no such part. */
export async function readPart(zip: JSZip, path: string): Promise<XNode | undefined> {
  const file = zip.file(path);
  return file ? rootOf(parseOrdered(await file.async("string"))) : undefined;
}

/** The package path a relationship `target` points at, from the part that holds it. */
export function resolveTarget(partPath: string, target: string): string {
  return target.startsWith("/")
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(partPath), target));
}

/** Relationships of a part; external targets (hyperlinks) are left out. */
export async function readRels(zip: JSZip, partPath: string): Promise<Rel[]> {
  const relsPath = posix.join(posix.dirname(partPath), "_rels", `${posix.basename(partPath)}.rels`);
  const root = await readPart(zip, relsPath);
  return childrenNamed(root, "Relationship")
    .filter((r) => attr(r, "TargetMode") !== "External")
    .map((r) => ({
      id: attr(r, "Id") ?? "",
      type: attr(r, "Type") ?? "",
      target: resolveTarget(partPath, attr(r, "Target") ?? ""),
    }));
}

/** The part a relationship of `partPath` points at, picked by the tail of its Type. */
export async function relatedPart(
  zip: JSZip,
  partPath: string,
  typeTail: string,
): Promise<string | undefined> {
  const rel = (await readRels(zip, partPath)).find((r) => r.type.endsWith(typeTail));
  return rel && zip.file(rel.target) ? rel.target : undefined;
}
