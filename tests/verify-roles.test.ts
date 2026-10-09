import { describe, expect, test } from "bun:test";

import { ROLES, parseRoleOptions, resolveRoles, roleKey, sharedServerWarnings, type RoleModel } from "../harness/roles.ts";

describe("parseRoleOptions", () => {
  test("ROLE=PROVIDER:MODEL, and a model id may hold colons", () => {
    const r = parseRoleOptions(["checker=ollama:qwen3.5:9b", "reviewer=claude-code:claude-opus-5-5"], [], []);
    expect(r).toEqual({
      checker: { provider: "ollama", model: "qwen3.5:9b" },
      reviewer: { provider: "claude-code", model: "claude-opus-5-5" },
    });
  });

  test("provider aliases take their canonical name", () => {
    const r = parseRoleOptions(["fixer=llama.cpp:m.gguf", "challenger=Claude-Code:claude-haiku-5-5"], [], []);
    expect(r).toEqual({
      fixer: { provider: "llamacpp", model: "m.gguf" },
      challenger: { provider: "claude-code", model: "claude-haiku-5-5" },
    });
  });

  test("a base URL and a context size attach to a role that names its model", () => {
    const r = parseRoleOptions(
      ["checker=ollama:qwen3.5:9b"],
      ["checker=http://192.168.1.169:11434"],
      ["checker=32768"],
    );
    expect(r).toEqual({
      checker: { provider: "ollama", model: "qwen3.5:9b", baseUrl: "http://192.168.1.169:11434", contextSize: 32768 },
    });
  });

  for (const [role, why] of [
    [["boss=ollama:m"], /unknown role 'boss'/],
    [["checker"], /ROLE=PROVIDER:MODEL/],
    [["checker=ollama"], /ROLE=PROVIDER:MODEL/],
    [["checker=:m"], /ROLE=PROVIDER:MODEL/],
    [["checker=ollama:"], /ROLE=PROVIDER:MODEL/],
    [["checker=ollama:a", "checker=ollama:b"], /checker is set twice/],
    [["__proto__=ollama:m"], /unknown role/],
    [["constructor=ollama:m"], /unknown role/],
  ] as const) {
    test(`--role ${role.join(" ")} is an error`, () => {
      const r = parseRoleOptions([...role], [], []);
      expect("error" in r && r.error).toMatch(why);
    });
  }

  test("a base URL or a context size for a role with no --role is an error", () => {
    expect(parseRoleOptions([], ["reviewer=http://h:1"], [])).toEqual({
      error: "--role-base-url reviewer: the role has no --role reviewer=PROVIDER:MODEL",
    });
    expect("error" in parseRoleOptions([], [], ["reviewer=8192"])).toBe(true);
  });

  test("a context size must be a whole number above 4096", () => {
    for (const bad of ["4096", "0", "x", "8192.5", ""]) {
      const r = parseRoleOptions(["checker=ollama:m"], [], [`checker=${bad}`]);
      expect("error" in r).toBe(true);
    }
  });

  test("a base URL or a context size on a claude-code role is an error", () => {
    expect("error" in parseRoleOptions(["reviewer=claude-code:m"], ["reviewer=http://h:1"], [])).toBe(true);
    expect("error" in parseRoleOptions(["reviewer=claude-code:m"], [], ["reviewer=8192"])).toBe(true);
  });
});

describe("resolveRoles", () => {
  const main: RoleModel = { provider: "claude-code", model: "claude-sonnet-5-5" };

  test("a role with no --role takes the main model, and a fixer with none follows the reviewer", () => {
    const opus = { provider: "claude-code", model: "claude-opus-5-5" };
    const r = resolveRoles(main, { reviewer: opus });
    expect(r.checker).toEqual(main);
    expect(r.challenger).toEqual(main);
    expect(r.reviewer).toEqual(opus);
    expect(r.fixer).toEqual(opus);
    expect(Object.keys(r)).toEqual([...ROLES]);
    const haiku = { provider: "claude-code", model: "claude-haiku-5-5" };
    expect(resolveRoles(main, { reviewer: opus, fixer: haiku }).fixer).toEqual(haiku);
    expect(resolveRoles(main, { fixer: haiku }).reviewer).toEqual(main);
  });

  test("the main model may have no provider (pi's own default)", () => {
    const r = resolveRoles({ provider: undefined, model: undefined }, {});
    for (const role of ROLES) expect(r[role]).toEqual({ provider: undefined, model: undefined });
  });
});

describe("roleKey", () => {
  test("two roles share a runtime only when provider, model, base URL and context size all match", () => {
    const a: RoleModel = { provider: "ollama", model: "m" };
    expect(roleKey(a)).toBe(roleKey({ provider: "ollama", model: "m" }));
    expect(roleKey(a)).not.toBe(roleKey({ provider: "ollama", model: "m", baseUrl: "http://h:1" }));
    expect(roleKey(a)).not.toBe(roleKey({ provider: "ollama", model: "m", contextSize: 8192 }));
    expect(roleKey(a)).not.toBe(roleKey({ provider: "llamacpp", model: "m" }));
  });
});

describe("sharedServerWarnings", () => {
  test("the checker and the challenger on two models of one local server: a warning", () => {
    const w = sharedServerWarnings({
      checker: { provider: "ollama", model: "a" },
      challenger: { provider: "ollama", model: "b" },
      reviewer: { provider: "claude-code", model: "x" },
      fixer: { provider: "claude-code", model: "x" },
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("checker");
    expect(w[0]).toContain("challenger");
    expect(w[0]).toContain("http://127.0.0.1:11434");
  });

  test("no warning for one model, for two servers, or for Claude Code", () => {
    const same = { provider: "ollama", model: "a" };
    const cc = { provider: "claude-code", model: "x" };
    expect(sharedServerWarnings({ checker: same, challenger: same, reviewer: cc, fixer: cc })).toEqual([]);
    expect(
      sharedServerWarnings({
        checker: { provider: "ollama", model: "a" },
        challenger: { provider: "ollama", model: "b", baseUrl: "http://192.168.1.169:11434" },
        reviewer: cc,
        fixer: cc,
      }),
    ).toEqual([]);
    expect(
      sharedServerWarnings({ checker: cc, challenger: { provider: "claude-code", model: "y" }, reviewer: cc, fixer: cc }),
    ).toEqual([]);
  });
});
