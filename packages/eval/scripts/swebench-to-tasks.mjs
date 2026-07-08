#!/usr/bin/env node
/**
 * Generate variance-probe task files from a SWE-bench instances JSON (Move 1,
 * Phase 0). Pure orchestration around the tested `instanceToTask` transform in
 * `@opencodehub/eval` — this file only does I/O (read instances, write task
 * files + test patches + a clone manifest); all task-shaping logic is the
 * unit-tested `src/swebench.ts`.
 *
 * INPUT — a JSON array of SWE-bench instances. Get one with:
 *   # SWE-bench Verified (500 human-validated instances), via the HF datasets viewer or:
 *   uvx --from datasets python -c "import datasets,json; \
 *     ds=datasets.load_dataset('princeton-nlp/SWE-bench_Verified', split='test'); \
 *     json.dump([dict(r) for r in ds.select(range(8))], open('/tmp/sb/instances.json','w'))"
 *
 * USAGE:
 *   node packages/eval/scripts/swebench-to-tasks.mjs \
 *     --instances /tmp/sb/instances.json \
 *     --out-dir   /tmp/sb/tasks \
 *     --clone-root /tmp/sb/repos \
 *     [--runner pytest|node] [--limit N]
 *
 * OUTPUT under --out-dir:
 *   <instance_id>.task.json   — the OCH task (feed to `code-pack --variance-probe`)
 *   <instance_id>.patch       — the test_patch the assertion applies
 *   clones.json               — the clone manifest the prep script consumes
 *
 * Then run scripts/swebench-prep.sh to clone + install + analyze, and finally
 * `codehub code-pack --variance-probe <task>.task.json --insight --json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { instanceToTask } from "../dist/swebench.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const instancesPath = args["instances"];
  const outDir = args["out-dir"];
  const cloneRoot = args["clone-root"];
  const runner = args["runner"] === "node" ? "node" : "pytest";
  const limit = args["limit"] !== undefined ? Number.parseInt(String(args["limit"]), 10) : undefined;

  if (typeof instancesPath !== "string" || typeof outDir !== "string" || typeof cloneRoot !== "string") {
    console.error(
      "usage: swebench-to-tasks.mjs --instances <in.json> --out-dir <dir> --clone-root <dir> [--runner pytest|node] [--limit N]",
    );
    process.exit(2);
  }

  const raw = await readFile(instancesPath, "utf8");
  const parsed = JSON.parse(raw);
  const instances = Array.isArray(parsed) ? parsed : [parsed];
  const selected = limit !== undefined ? instances.slice(0, limit) : instances;

  await mkdir(outDir, { recursive: true });
  const clones = [];
  for (const instance of selected) {
    const testPatchPath = join(outDir, `${instance.instance_id}.patch`);
    const gen = instanceToTask(instance, { cloneRoot, testPatchPath, runner });
    await writeFile(join(outDir, `${instance.instance_id}.task.json`), JSON.stringify(gen.task, null, 2));
    await writeFile(testPatchPath, gen.testPatch);
    clones.push(gen.clone);
  }
  await writeFile(join(outDir, "clones.json"), JSON.stringify(clones, null, 2));

  console.error(`Wrote ${selected.length} task(s) + patches + clones.json to ${outDir}`);
  console.error(`Next: bash packages/eval/scripts/swebench-prep.sh ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
