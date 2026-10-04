// Runs one exported function of a grader module and prints its result as one "RESULT <json>" line.
// The tests start this in a subprocess so each call gets its own environment (bench root, staging
// directory, PATH) and no module state is shared with the test process.
//
// usage: bun run-grader.ts <bench> <function> <json array of arguments>
const [bench, fn, argsJson] = process.argv.slice(2);
const mod = (await import(`../../../harness/grade/${bench}.ts`)) as Record<
  string,
  (...a: unknown[]) => unknown
>;
const result = await mod[fn!]!(...(JSON.parse(argsJson ?? "[]") as unknown[]));
console.log(`RESULT ${JSON.stringify(result)}`);
