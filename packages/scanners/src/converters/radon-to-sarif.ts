/**
 * Radon JSON → SARIF v2.1.0 converter.
 *
 * Radon's `cc -j` (cyclomatic complexity JSON) output is a map keyed by
 * file path:
 *
 *   {
 *     "src/app.py": [
 *       { "type": "function", "name": "handler", "rank": "C",
 *         "complexity": 12, "lineno": 42, "endline": 80, "col_offset": 0,
 *         "classname": null }
 *     ]
 *   }
 *
 * `rank` is one of A..F (A best, F worst). We emit one SARIF result per
 * block whose `complexity > 10` (matches the default Radon gate). The
 * ruleId includes the rank so downstream filtering can separate mild
 * (C) from severe (D/E/F) complexity:
 *
 *   - ruleId   = `radon.complexity.<rank>` (fallback: `radon.complexity`)
 *   - level    = `warning` if rank in {C,D,E,F}, else `note`
 *   - message  = `Cyclomatic complexity <n> (rank <R>) in <type> <name>`
 *   - location = artifactLocation { uri: <path> } + region.startLine + endLine
 *   - properties.opencodehub.complexity = <n>
 *   - properties.opencodehub.rank       = <rank>
 *   - properties.opencodehub.blockType  = <function|method|class>
 *
 * Output is validated against `SarifLogSchema` before return.
 */

import type { SarifLog, SarifResult, SarifRun } from "@opencodehub/sarif";
import { SarifLogSchema } from "@opencodehub/sarif";
import { RADON_SPEC } from "../catalog.js";

/** Complexity threshold above which a block produces a SARIF result. */
const COMPLEXITY_THRESHOLD = 10;

/** Ranks that trigger a `warning` level finding; others emit `note`. */
const WARN_RANKS: ReadonlySet<string> = new Set(["C", "D", "E", "F"]);

interface RadonBlock {
  readonly name?: string;
  readonly type?: string;
  readonly rank?: string;
  readonly complexity?: number;
  readonly lineno?: number;
  readonly endline?: number;
  readonly classname?: string | null;
}

/** Convert a parsed Radon JSON map to a SARIF log. */
export function radonJsonToSarif(json: unknown): SarifLog {
  const results: SarifResult[] = [];
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    const map = json as Record<string, unknown>;
    const paths = Object.keys(map).sort();
    for (const path of paths) {
      const blocks = map[path];
      if (!Array.isArray(blocks)) continue;
      for (const raw of blocks) {
        if (typeof raw !== "object" || raw === null) continue;
        const block = raw as RadonBlock;
        const complexity = typeof block.complexity === "number" ? block.complexity : undefined;
        if (complexity === undefined || complexity <= COMPLEXITY_THRESHOLD) continue;
        const rank = typeof block.rank === "string" ? block.rank.toUpperCase() : undefined;
        const startLine =
          typeof block.lineno === "number" && block.lineno > 0 ? block.lineno : undefined;
        const endLine =
          typeof block.endline === "number" && block.endline >= (startLine ?? 1)
            ? block.endline
            : undefined;
        const blockType = typeof block.type === "string" ? block.type : "block";
        const blockName = typeof block.name === "string" ? block.name : "<anonymous>";
        const ruleId =
          rank !== undefined && rank.length > 0 ? `radon.complexity.${rank}` : "radon.complexity";
        const level: "warning" | "note" =
          rank !== undefined && WARN_RANKS.has(rank) ? "warning" : "note";
        const messageText = `Cyclomatic complexity ${complexity}${
          rank !== undefined ? ` (rank ${rank})` : ""
        } in ${blockType} ${blockName}`;
        const region: { startLine?: number; endLine?: number } = {};
        if (startLine !== undefined) region.startLine = startLine;
        if (endLine !== undefined) region.endLine = endLine;
        const result: SarifResult = {
          ruleId,
          level,
          message: { text: messageText },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: path },
                ...(Object.keys(region).length > 0 ? { region } : {}),
              },
            },
          ],
          properties: {
            opencodehub: {
              complexity,
              blockType,
              ...(rank !== undefined ? { rank } : {}),
            },
          },
        };
        results.push(result);
      }
    }
  }
  const run: SarifRun = {
    tool: { driver: { name: RADON_SPEC.id, version: RADON_SPEC.version } },
    results,
  };
  const log: SarifLog = { version: "2.1.0", runs: [run] };
  const parsed = SarifLogSchema.safeParse(log);
  return parsed.success ? parsed.data : { version: "2.1.0", runs: [run] };
}
