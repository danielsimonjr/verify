/**
 * The four verifier roles and the model each one uses.
 *
 * By default every role uses the driver's `--provider` and `--model` (the lane). `--role ROLE=PROVIDER:MODEL`
 * gives one role its own model; `--role-base-url ROLE=URL` and `--role-context-size ROLE=N` set the
 * server and the context window of a local role. Each role maps to a phase of the driver:
 *
 *   checker    → the `elim` investigation (claims the rollouts disagree on)
 *   challenger → the `fals` investigation (claims they share)
 *   reviewer   → the adjudication, which writes finish.json
 *   fixer      → the repair, which writes repair.json and out/deliverables/
 */

import { CLAUDE_CODE_PROVIDER, isClaudeCodeProvider } from "./claude/provider.js";
import { DEFAULT_LLAMACPP_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "./model/config.js";
import { canonicalLocalProvider } from "./model/index.js";

/** The verifier roles, in the order of their phases. */
export const ROLES = ["checker", "challenger", "reviewer", "fixer"] as const;
/** One verifier role: `checker`, `challenger`, `reviewer` or `fixer`. */
export type Role = (typeof ROLES)[number];

/** The model of one role. `provider` and `model` are undefined when the run leaves pi its own default. */
export interface RoleModel {
  provider: string | undefined;
  model: string | undefined;
  baseUrl?: string;
  contextSize?: number;
}

/** pi needs more than its 4096-token reserve to generate (docs/local-models.md, "Context length"). */
const MIN_CONTEXT = 4096;

function isRole(name: string): name is Role {
  return (ROLES as readonly string[]).includes(name);
}

/** The canonical provider name: `claude-code`, a local backend id, or the name as given. */
export function canonicalProvider(name: string): string {
  if (isClaudeCodeProvider(name)) return CLAUDE_CODE_PROVIDER;
  return canonicalLocalProvider(name) ?? name;
}

/** Split `ROLE=VALUE`, checking the role. */
function roleValue(option: string, entry: string): { role: Role; value: string } | { error: string } {
  const eq = entry.indexOf("=");
  if (eq < 0) return { error: `${option} '${entry}': expected ROLE=${option === "--role" ? "PROVIDER:MODEL" : "VALUE"}` };
  const name = entry.slice(0, eq);
  if (!isRole(name)) return { error: `${option}: unknown role '${name}' (known: ${ROLES.join(", ")})` };
  return { role: name, value: entry.slice(eq + 1) };
}

/** The model a `--role-base-url` or `--role-context-size` entry tunes: it must be a local role's. */
function localRoleSpec(option: string, role: Role, set: Partial<Record<Role, RoleModel>>): RoleModel | { error: string } {
  const spec = set[role];
  if (!spec) return { error: `${option} ${role}: the role has no --role ${role}=PROVIDER:MODEL` };
  if (spec.provider === CLAUDE_CODE_PROVIDER) return { error: `${option} ${role}: not supported with claude-code` };
  if (!canonicalLocalProvider(spec.provider)) return { error: `${option} ${role}: only for ollama and llamacpp roles` };
  return spec;
}

/**
 * Parse the repeatable `--role`, `--role-base-url` and `--role-context-size` options.
 * Returns the roles that were set, or the first error.
 */
export function parseRoleOptions(
  roles: readonly string[],
  baseUrls: readonly string[],
  contextSizes: readonly string[],
): Partial<Record<Role, RoleModel>> | { error: string } {
  const out: Partial<Record<Role, RoleModel>> = {};
  for (const entry of roles) {
    const parsed = roleValue("--role", entry);
    if ("error" in parsed) return parsed;
    const colon = parsed.value.indexOf(":");
    const provider = colon < 0 ? "" : parsed.value.slice(0, colon).trim();
    const model = colon < 0 ? "" : parsed.value.slice(colon + 1).trim();
    if (!provider || !model) return { error: `--role '${entry}': expected ROLE=PROVIDER:MODEL` };
    if (out[parsed.role]) return { error: `--role: ${parsed.role} is set twice` };
    out[parsed.role] = { provider: canonicalProvider(provider), model };
  }
  for (const entry of baseUrls) {
    const parsed = roleValue("--role-base-url", entry);
    if ("error" in parsed) return parsed;
    const spec = localRoleSpec("--role-base-url", parsed.role, out);
    if ("error" in spec) return spec;
    if (!parsed.value) return { error: `--role-base-url ${parsed.role}: empty URL` };
    spec.baseUrl = parsed.value;
  }
  for (const entry of contextSizes) {
    const parsed = roleValue("--role-context-size", entry);
    if ("error" in parsed) return parsed;
    const spec = localRoleSpec("--role-context-size", parsed.role, out);
    if ("error" in spec) return spec;
    const n = /^\d+$/.test(parsed.value) ? Number(parsed.value) : NaN;
    if (!Number.isSafeInteger(n) || n <= MIN_CONTEXT) {
      return { error: `--role-context-size ${parsed.role}: needs a whole number above ${MIN_CONTEXT}, got '${parsed.value}'` };
    }
    spec.contextSize = n;
  }
  return out;
}

/**
 * The model of every role: its own when `--role` set one, the main model otherwise. A fixer with no
 * `--role` follows the reviewer, so it keeps the reviewer's session and sees how the plan was made.
 */
export function resolveRoles(main: RoleModel, set: Partial<Record<Role, RoleModel>>): Record<Role, RoleModel> {
  const reviewer = set.reviewer ?? main;
  return {
    checker: set.checker ?? main,
    challenger: set.challenger ?? main,
    reviewer,
    fixer: set.fixer ?? reviewer,
  };
}

/** Roles with the same key share one runtime (and, for the reviewer and the fixer, one session). */
export function roleKey(m: RoleModel): string {
  return JSON.stringify([m.provider ?? null, m.model ?? null, m.baseUrl ?? null, m.contextSize ?? null]);
}

/** The server a local role talks to, or null for any other provider. */
function localServer(m: RoleModel): string | null {
  const local = canonicalLocalProvider(m.provider);
  if (!local) return null;
  return m.baseUrl ?? (local === "ollama" ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LLAMACPP_BASE_URL);
}

/**
 * The checker and the challenger run at the same time. Two different models on one local server must
 * both be loaded at once, or the server swaps them between requests and every turn stalls.
 */
export function sharedServerWarnings(roles: Record<Role, RoleModel>): string[] {
  const a = roles.checker;
  const b = roles.challenger;
  const server = localServer(a);
  if (server === null || server !== localServer(b) || roleKey(a) === roleKey(b)) return [];
  const what = (m: RoleModel): string => (m.contextSize ? `${m.model}, context ${m.contextSize}` : `${m.model}`);
  return [
    `the checker (${what(a)}) and the challenger (${what(b)}) run at the same time on one server, ${server}: ` +
      `it must hold both at once or reload on every request; use one model and one context size, or two servers`,
  ];
}

/** One line for the log: the model of each role. */
export function describeRoles(roles: Record<Role, RoleModel>): string {
  return ROLES.map((role) => {
    const m = roles[role];
    const where = m.baseUrl ? `@${m.baseUrl}` : "";
    return `${role}=${m.provider ?? "default"}:${m.model ?? "default"}${where}`;
  }).join(" ");
}
