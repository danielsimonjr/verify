/** The version a `vX.Y.Z` or `refs/tags/vX.Y.Z` ref names, or null for any other ref. */
export function versionFromTag(tag: string): string | null;
/** Whether the tag names `packageVersion`, with a message that says why. */
export function assertTagMatchesPackageVersion(tag: string, packageVersion: string): { ok: boolean; message: string };
