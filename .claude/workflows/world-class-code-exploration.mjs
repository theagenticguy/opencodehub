export const meta = {
  name: 'world-class-code-exploration',
  description: 'Root-cause + design + verify fixes for the OpenCodeHub field-report issues and chart what makes code exploration world-class',
  phases: [
    { title: 'Diagnose', detail: 'pin exact root cause + fix site for each issue (grounded in code)' },
    { title: 'Vision', detail: 'parallel lenses on what world-class code-exploration requires beyond the reported issues' },
    { title: 'Design', detail: 'concrete fix design per issue, with test shape' },
    { title: 'Adversarial verify', detail: 'skeptics try to refute each design' },
    { title: 'Synthesize', detail: 'prioritized roadmap: confirmed fixes + vision gaps' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context — the grounded findings I (orchestrator) already proved, so
// agents don't re-derive from scratch and don't repeat the field report's
// wrong hypotheses. Each agent re-verifies against the live code.
// ---------------------------------------------------------------------------
const REPO = '/Users/lalsaado/Projects/open-code-hub'
const SUBJECT = '/Users/lalsaado/Projects/ngs-research-agent'

const GROUNDING = `
You are improving OpenCodeHub (OCH), a local code-graph + MCP tool for AI-driven
code exploration. Repo root: ${REPO}. A field report drove an exploration session
THROUGH the codehub CLI against subject repo ${SUBJECT} (a Python stdio MCP server,
src-layout package ngs_research_agent) and filed 6 issues.

CRITICAL grounded facts the orchestrator already PROVED empirically (re-verify, do
not contradict without equally strong evidence — cite file:line + a repro):

ISSUE 1 (the report's headline "cross-module CALLS edges drop / FQN-vs-filepath
node-identity mismatch") — the report's hypothesis is WRONG for Python. Proven:
  - scip-python emits ONE symbol string for both the def and every ref of
    get_bedrock_client (no src/dist or external/FQN split like TS has).
  - The decorated function get_bedrock_client (sole @cache-decorated def in
    client.py) is DROPPED from the persisted lbug graph. WASM parse captures it,
    pythonProvider.extractDefinitions returns it [146-171], idForDefinition gives a
    unique id, KnowledgeGraph.addNode (packages/core-types/src/graph.ts) dedups by
    id — yet the final graph has 5/6 client.py Function nodes; get_bedrock_client's
    Function node is absent while its body Variables AND a Process node referencing
    its (missing) Function id DO persist. Discriminator vs the 5 survivors: it's the
    only bare-name @cache-decorated def. So the real bug is "decorated function def
    lost between extraction and persistence/bulk-load". Suspect the lbug node COPY
    struct-field type seeding (packages/storage/src/graphdb-adapter.ts
    NODE_COPY_SUBQUERY / NODE_SENTINEL_ID) OR a later phase, OR decorated_definition
    range handling.
  - Bug A (independent, confirmed): extractPyImports in
    packages/ingestion/src/providers/python.ts is LINE-BASED and silently drops
    multi-line parenthesized imports: \`from pkg.mod import (\\n a,\\n b,\\n)\` →
    first line rest="(" → 0 names → discarded. Ubiquitous in real Python.
  - Bug B (confirmed): preprocessPyImportPath leaves dotted absolute imports
    unchanged; resolveImportTarget (packages/ingestion/src/pipeline/phases/parse.ts
    :761) only handles ./ ../ / → src-layout package imports (ngs_research_agent.client
    → src/ngs_research_agent/client.py) stub as <external>.

ISSUE 2: scan runner runs vulture (and radon, ty) against the absolute repo tree
with NO exclude → vulture walks .venv/ → 127/133 findings are library noise. The
indexer already excludes via HARDCODED_IGNORES (packages/ingestion/src/pipeline/
gitignore.ts:225 incl ".venv"), exported via the pipeline barrel. semgrep/ruff dodge
it by targeting "." and honoring gitignore. Fix: thread an exclude list into a new
VultureWrapperOptions (mirror pip-audit's options plumbing through
DefaultWrapperContext), populate from pipeline.HARDCODED_IGNORES in CLI
buildWrapperContext (packages/cli/src/commands/scan.ts), emit vulture --exclude
<comma-joined>. Apply to radon.ts + ty.ts too.

ISSUE 3: list_findings/list_dead_code/license_audit/owners/route_map/project_profile/
risk_trends/api_impact are MCP-only; no CLI subcommand (CLI uses commander, entry
packages/cli/src/index.ts; verdict is the canonical CLI↔MCP shared-fn template —
both call computeVerdict from @opencodehub/analysis). list_findings (store.graph
.listFindings), list_dead_code (classifyDeadness), license_audit (classifyDependencies
+ listDependencies), project_profile (listNodesByKind), risk_trends (computeRiskTrends
+ loadSnapshots, already used in wiki.ts) are THIN; owners/route_map/api_impact are
inlined in MCP handlers (need extraction to @opencodehub/analysis).

ISSUE 4: codehub sql exposes only cochanges + symbol_summaries (DuckDB temporal
tier); the node/edge graph lives in lbug (graph.lbug) and is NOT SQL-queryable.
Docs oversell "SQL against the graph store". Fix docs framing or add a read-only
nodes/edges view.

ISSUE 5: symbol_summaries empty → query silently runs BM25-only even though doctor
reports embedder weights present. status should surface "summaries: N / vectors:
bm25-only|hybrid".

ISSUE 6: doctor reports "bandit OK" by binary presence but bandit lacks the [sarif]
extra → scan can't use it (argparse rejects -f sarif, exit 2, 0 findings). doctor
should probe the formatter, not just --version. (installCmd already fixed to
uv tool install 'bandit[sarif]' in a merged PR.)

Storage interface: IGraphStore in packages/storage/src/interface.ts has listNodes,
listNodesByKind, listEdgesByType, listFindings, listDependencies, listRoutes.
ITemporalStore holds cochanges + symbol_summaries. ADR 0016 (DuckDB graph rip),
ADR 0015 (WASM-only parser). Durable lessons in .erpaval/INDEX.md.
`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'rootCause', 'evidence', 'fixSites', 'severity', 'confidence'],
  properties: {
    issue: { type: 'string', description: 'Issue id, e.g. "Issue 1" / "Issue 1 Bug A"' },
    rootCause: { type: 'string', description: 'The precise mechanism, in 1-3 sentences' },
    evidence: {
      type: 'array', items: { type: 'string' },
      description: 'file:line citations + repro observations that prove the root cause',
    },
    fixSites: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'what'],
        properties: {
          file: { type: 'string' },
          what: { type: 'string', description: 'the change to make at this site' },
        },
      },
    },
    severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
    confidence: { type: 'number', description: '0..1 that this root cause is correct' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const VISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'gaps'],
  properties: {
    lens: { type: 'string' },
    gaps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['capability', 'whyItMatters', 'effort', 'leverage'],
        properties: {
          capability: { type: 'string', description: 'a missing/weak capability for world-class code exploration' },
          whyItMatters: { type: 'string' },
          existingFoundation: { type: 'string', description: 'what in OCH today it builds on (file/tool), or "greenfield"' },
          effort: { enum: ['S', 'M', 'L', 'XL'] },
          leverage: { enum: ['transformational', 'high', 'medium', 'low'] },
        },
      },
    },
  },
}

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['issue', 'approach', 'diffSketch', 'testShape', 'risks', 'blastRadius'],
  properties: {
    issue: { type: 'string' },
    approach: { type: 'string', description: 'the concrete fix, including exact functions/signatures touched' },
    diffSketch: { type: 'string', description: 'pseudo-diff or precise prose of the edits per file' },
    testShape: { type: 'string', description: 'the regression test(s) to add and where' },
    risks: { type: 'array', items: { type: 'string' } },
    blastRadius: { type: 'string', description: 'what else could break; which packages rebuild' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['issue', 'holds', 'reason'],
  properties: {
    issue: { type: 'string' },
    holds: { type: 'boolean', description: 'true if the design is sound and the root cause is right' },
    reason: { type: 'string' },
    mustFix: { type: 'array', items: { type: 'string' }, description: 'concrete corrections the design needs before implementation' },
  },
}

// ---------------------------------------------------------------------------
// PHASE 1 — Diagnose: one agent per issue, grounded, returns structured RC.
// Issue 1 gets the deepest treatment (its own dedicated bisection agent).
// ---------------------------------------------------------------------------
const ISSUES = [
  {
    id: 'Issue 1 (decorated-func drop)',
    label: 'diag:issue1-core',
    prompt: `${GROUNDING}

YOUR TASK: Pin the EXACT drop point for the @cache-decorated get_bedrock_client
Function node. It survives pythonProvider.extractDefinitions but is absent from the
persisted lbug graph. Bisect the path: parse phase addNode loop
(packages/ingestion/src/pipeline/phases/parse.ts ~363-378) → later phases that
mutate nodes (processes.ts, accesses.ts, orm.ts, ownership.ts) → the lbug bulk-load
(packages/storage/src/graphdb-adapter.ts NODE_COPY_SUBQUERY, struct-field type
seeding, COPY ... IGNORE_ERRORS, any per-row filter on null startLine/endLine or
field-shape). Read every candidate. Form ONE concrete root-cause hypothesis with the
exact file:line where the node is dropped or overwritten, and explain why ONLY the
decorated def is affected (what's structurally different about its GraphNode — range
from decorated_definition? a field that trips the COPY type-seeding?). Also confirm
or correct Bug A (multi-line imports) and Bug B (src-layout resolution) with file:line.
Return THREE diagnosis objects (Issue 1 core, Issue 1 Bug A, Issue 1 Bug B) — but
this schema is one object, so return the CORE one here and put Bug A + Bug B findings
in openQuestions as "Bug A: ..." / "Bug B: ..." one-liners with their fix sites.`,
    schema: DIAGNOSIS_SCHEMA,
  },
  {
    id: 'Issue 2 (vulture .venv)',
    label: 'diag:issue2',
    prompt: `${GROUNDING}\n\nYOUR TASK: Confirm Issue 2 root cause and the cleanest fix
site. Read packages/scanners/src/wrappers/{vulture,radon,ty,semgrep,ruff}.ts,
packages/scanners/src/spec.ts (ScannerRunContext), packages/scanners/src/index.ts
(DefaultWrapperContext, createWrapperFor), packages/cli/src/commands/scan.ts
(buildWrapperContext), and packages/ingestion/src/pipeline/gitignore.ts
(HARDCODED_IGNORES + barrel export). Verify vulture supports --exclude (comma glob).
Confirm scanners package does NOT depend on ingestion (so threading from CLI is the
right seam). Return the diagnosis with exact fixSites.`,
    schema: DIAGNOSIS_SCHEMA,
  },
  {
    id: 'Issue 3 (MCP-only CLI gap)',
    label: 'diag:issue3',
    prompt: `${GROUNDING}\n\nYOUR TASK: For each MCP-only reader (list_findings,
list_dead_code, license_audit, project_profile, risk_trends, owners, route_map,
api_impact) confirm whether it calls a shared @opencodehub/analysis fn or storage
reader (THIN) vs inlined logic in the MCP handler (EXTRACT). Read packages/mcp/src/
tools/*.ts for each + packages/cli/src/index.ts registration pattern + a template
command (verdict.ts). Return a diagnosis whose fixSites enumerate, per tool, the new
CLI command file + the lib fn it calls, and flag the 4-5 cheapest thin wins.`,
    schema: DIAGNOSIS_SCHEMA,
  },
  {
    id: 'Issue 4 (sql framing)',
    label: 'diag:issue4',
    prompt: `${GROUNDING}\n\nYOUR TASK: Confirm what \`codehub sql\` can reach. Read the
sql command (packages/cli/src/commands/sql.ts or similar), ITemporalStore vs
IGraphStore (packages/storage/src/interface.ts), and where the "SQL against the graph
store" wording appears (CLAUDE.md, docs/, --help strings, MCP tool descriptions).
Decide: doc-only fix vs adding a read-only nodes/edges view. Return diagnosis + fixSites.`,
    schema: DIAGNOSIS_SCHEMA,
  },
  {
    id: 'Issue 5 (status summaries/vectors)',
    label: 'diag:issue5',
    prompt: `${GROUNDING}\n\nYOUR TASK: Read the status command (packages/cli/src/
commands/status.ts) and how query decides bm25 vs hybrid (search package + how it
checks symbol_summaries / embeddings presence). Determine where status should read
summaries count + vector mode and what exact line to print. Return diagnosis + fixSites.`,
    schema: DIAGNOSIS_SCHEMA,
  },
  {
    id: 'Issue 6 (doctor bandit[sarif])',
    label: 'diag:issue6',
    prompt: `${GROUNDING}\n\nYOUR TASK: Read the bandit doctor check + the bandit
wrapper (packages/cli/src/commands/doctor.ts binaryOnPathCheck for bandit;
packages/scanners/src/wrappers/bandit.ts banditExitAdvisory). Design a probe that
verifies the [sarif] formatter is actually usable (e.g. run \`bandit -f sarif\` on a
tiny temp input and check exit!=2 / no usage banner, or check the
bandit-sarif-formatter entry point). Return diagnosis + fixSites.`,
    schema: DIAGNOSIS_SCHEMA,
  },
]

phase('Diagnose')
const diagnoses = await parallel(
  ISSUES.map((iss) => () =>
    agent(iss.prompt, { label: iss.label, phase: 'Diagnose', schema: DIAGNOSIS_SCHEMA, agentType: 'Explore' }),
  ),
)
const confirmedDiagnoses = diagnoses.filter(Boolean)
log(`Diagnosed ${confirmedDiagnoses.length}/${ISSUES.length} issues`)

// ---------------------------------------------------------------------------
// PHASE 2 — Vision (parallel, runs concurrently with nothing depending on it
// until synthesis): what does WORLD-CLASS code exploration require, beyond the
// 6 reported issues? Distinct lenses so they don't converge.
// ---------------------------------------------------------------------------
const LENSES = [
  {
    lens: 'Graph correctness & completeness',
    angle: `What categories of edges/nodes does OCH likely MISS or mis-bind today
(beyond decorated funcs)? Think: dynamic dispatch, re-exports, decorators-as-wrappers,
class attributes, async/await call chains, test→src coverage edges, monkeypatch,
dependency-injection. What would make the graph trustworthy enough that a user
believes the blast-radius number? Ground in OCH's parse/scip phases.`,
  },
  {
    lens: 'Retrieval quality (BM25 → hybrid → reranked)',
    angle: `The report found query silently runs BM25-only (no summaries/vectors).
What does world-class code retrieval look like — hybrid dense+sparse, symbol
summaries, query understanding, result grouping by process/flow, reranking? What does
OCH have (embedder, search package) vs need? How to make hybrid the default that
"just works" after analyze.`,
  },
  {
    lens: 'Agent ergonomics & CLI/MCP parity',
    angle: `OCH is driven BY an LLM agent. What makes a code-graph tool delightful for
an agent: CLI↔MCP parity, structured + human output, disambiguation that never omits
the real node, --kind/--exclude-docs defaults, next-step hints, staleness signals,
self-describing errors (like AMBIGUOUS_REPO). What's missing for an agent to drive
exploration confidently end-to-end?`,
  },
  {
    lens: 'Trust, verification & "show your work"',
    angle: `For impact/verdict to be trusted: edge provenance (scip vs heuristic
confidence), "why is this in the blast radius" path explanations, coverage of the
graph (what % of calls resolved vs dropped to <external>), a self-diagnostic that
reports graph health (orphan rate, unresolved-import rate). What would let a user
audit the graph's own accuracy?`,
  },
]

phase('Vision')
const visions = await parallel(
  LENSES.map((l) => () =>
    agent(
      `${GROUNDING}\n\nYOU ARE A PRODUCT+ARCHITECTURE STRATEGIST for "world-class code
exploration & understanding". LENS: ${l.lens}.\n${l.angle}\n\nReturn 3-6 concrete
capability gaps. For each: why it matters for an AI agent exploring code, what OCH
foundation it builds on (cite a file/tool/package) or "greenfield", effort (S/M/L/XL),
and leverage. Be specific to THIS codebase — no generic advice. Prefer gaps that the
existing architecture (lbug graph, scip-ingest, embedder, 28 MCP tools, IGraphStore)
makes cheap to reach.`,
      { label: `vision:${l.lens.slice(0, 18)}`, phase: 'Vision', schema: VISION_SCHEMA, agentType: 'Explore' },
    ),
  ),
)
const confirmedVisions = visions.filter(Boolean)
log(`Collected ${confirmedVisions.length} vision lenses`)

// ---------------------------------------------------------------------------
// PHASE 3+4 — Design each confirmed diagnosis, then adversarially verify.
// Pipeline: a design verifies as soon as it's produced (no global barrier).
// ---------------------------------------------------------------------------
phase('Design')
const designVerdicts = await pipeline(
  confirmedDiagnoses,
  (diag) =>
    agent(
      `${GROUNDING}\n\nYOU ARE A STAFF ENGINEER designing the fix for: ${diag.issue}.
Confirmed root cause: ${diag.rootCause}
Evidence: ${(diag.evidence || []).join(' | ')}
Fix sites: ${JSON.stringify(diag.fixSites)}

Produce an implementation-ready design: exact functions/signatures, a pseudo-diff per
file, the regression test(s) and where they live (match existing test conventions),
risks, and blast radius (which packages rebuild, what else could break). Match the
repo's idioms (DI seams in scanner wrappers, commander registration, structured-output
schemas). Do NOT write the code — design it precisely enough that implementation is
mechanical.`,
      { label: `design:${diag.issue.slice(0, 22)}`, phase: 'Design', schema: DESIGN_SCHEMA, agentType: 'Explore' },
    ),
  async (design, diag) => {
    const LENSES_V = ['correctness', 'completeness', 'repro-or-refute']
    const thunks = LENSES_V.map((angleName) => () =>
      agent(
        `${GROUNDING}\n\nYOU ARE A SKEPTIC. Default to holds=false unless the design
is clearly sound. Lens: ${angleName}.
Issue: ${diag.issue}
Root cause claim: ${diag.rootCause}
Design: ${design ? design.approach : '(design failed)'}
Diff sketch: ${design ? design.diffSketch : ''}
Test shape: ${design ? design.testShape : ''}

Try to REFUTE: is the root cause actually right? Will this fix actually resolve the
reported symptom without breaking the 5 surviving cases / other languages / other
scanners? Is the test real (would it fail before, pass after)? For ${angleName}
specifically, find the hole. Return holds + reason + mustFix corrections.`,
        { label: `verify:${diag.issue.slice(0, 14)}:${angleName}`, phase: 'Adversarial verify', schema: VERDICT_SCHEMA, agentType: 'Explore' },
      ),
    )
    const votes = (await parallel(thunks)).filter(Boolean)
    const holdCount = votes.filter((x) => x.holds).length
    return {
      issue: diag.issue,
      severity: diag.severity,
      confidence: diag.confidence,
      rootCause: diag.rootCause,
      fixSites: diag.fixSites,
      design,
      survives: holdCount >= 2,
      votes,
      mustFix: votes.flatMap((x) => x.mustFix || []),
    }
  },
)
const designs = designVerdicts.filter(Boolean)

// ---------------------------------------------------------------------------
// PHASE 5 — Synthesize: one agent merges confirmed designs + vision gaps into
// a single prioritized roadmap. Gets the full structured corpus.
// ---------------------------------------------------------------------------
phase('Synthesize')
const synthesis = await agent(
  `${GROUNDING}\n\nYOU ARE THE TECH LEAD. Synthesize a single prioritized roadmap to
make OpenCodeHub WORLD-CLASS for exploring and understanding code.

CONFIRMED FIXES (root cause + design + adversarial verdict):
${JSON.stringify(designs.map((d) => ({ issue: d.issue, severity: d.severity, survives: d.survives, rootCause: d.rootCause, approach: d.design?.approach, mustFix: d.mustFix })), null, 1)}

VISION GAPS (what world-class requires beyond the reported issues):
${JSON.stringify(confirmedVisions.flatMap((v) => v.gaps.map((g) => ({ lens: v.lens, ...g }))), null, 1)}

Produce, in Markdown:
1. **Ship now (this PR series)** — the confirmed bug fixes that SURVIVED adversarial
   review, in dependency/priority order, each with the one-line fix and any mustFix
   corrections folded in. Call out Issue 1 core (decorated-func drop) as the headline
   correctness fix and whether it's ready or needs more diagnosis.
2. **Fast follow** — designs that need the mustFix corrections, or thin vision gaps.
3. **World-class roadmap** — the transformational/high-leverage vision gaps grouped by
   theme (graph correctness, hybrid retrieval, agent ergonomics, trust/verification),
   each with effort + the OCH foundation it builds on.
4. **What I'd cut / defer** and why.
Be decisive and specific to this codebase. This is the plan the orchestrator will
implement, so make "Ship now" directly actionable.`,
  { label: 'synthesize:roadmap', phase: 'Synthesize' },
)

return {
  diagnoses: confirmedDiagnoses,
  designs: designs.map((d) => ({ issue: d.issue, survives: d.survives, severity: d.severity, mustFix: d.mustFix })),
  visionGapCount: confirmedVisions.flatMap((v) => v.gaps).length,
  roadmap: synthesis,
}
