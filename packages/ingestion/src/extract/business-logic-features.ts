/**
 * Business-logic / plumbing FEATURE EXTRACTOR — the companion producer for the
 * already-shipped `classifyPlumbing` sieve in `@opencodehub/analysis`
 * (`packages/analysis/src/business-logic.ts`).
 *
 * This is a faithful TypeScript port of the deterministic feature-derivation
 * half of `och_bizlogic_extract.py` (the "student substrate" extractor). The
 * shipped sieve numbers — 0.936 plumbing precision, 0.925 business recall —
 * depend on reproducing the Python marker logic EXACTLY, so this module copies
 * the Python's marker sets, word-boundary matching, qualified-call gating, and
 * camelCase component rules verbatim. It is a precision port, not a
 * reimagining: where the Python uses a word-boundary / component / exact match,
 * this module uses the SAME shape and never falls back to loose substring
 * matching (the substring path is what produced flask's 110 false-persistence
 * hits; the precise path cut it to 9).
 *
 * ## Interface contract
 *
 * The kernel consumes four fields. This extractor computes exactly those four
 * from the symbol's source text:
 *
 *   - `nSerializationCalls` — count of calls whose method/head word matches
 *     {@link SERIALIZATION_MARKERS} (word-boundary, per call).
 *   - `nDomainSignals` — POSITIVE domain residue: domain conditionals
 *     (non-guard `if`) + arithmetic operators + raised domain exceptions +
 *     state-machine transitions. Mirrors the Python iter-4
 *     `n_domain_signals = n_domain_conditionals + n_arithmetic_ops +
 *     n_domain_exceptions + n_state_transitions`.
 *   - `nPlumbingSignals` — NEGATIVE plumbing tells, composed EXACTLY as the
 *     Python `n_plumbing_signals` (och_bizlogic_extract.py lines 767-769):
 *     `n_serialization_calls + n_observ_calls + (is_getter_setter ? 1 : 0) +
 *     (dto_mapper_ratio >= 0.5 ? 1 : 0)`. It deliberately does NOT include
 *     qualified-persistence, raw-SQL, or bootstrap — those feed the Python's
 *     `touches_persistence` / `is_framework_bootstrap` fields, which the shipped
 *     kernel does NOT read.
 *   - `isOrmModel` — class-head ORM-base match (exact base superclass OR
 *     camelCase component role).
 *
 * ## Text vs. tree
 *
 * The Python mixes tree-walking (if / raise / binary-op / assignment / call
 * nodes) with text-and-regex markers applied to each node's text. This port
 * receives the symbol's body as TEXT (`bodyText`) — there is no parser handle
 * in the signature, and the function is pure/sync. So the tree-structural
 * features (conditionals, arithmetic, exceptions, transitions, call
 * enumeration) are reproduced with line/token scanning that matches the
 * Python's per-node matchers. The marker / qualified-call / raw-SQL / camelCase
 * helpers are ported VERBATIM from the Python regexes because they are already
 * text-and-regex in the source. See the divergence notes inline.
 *
 * Determinism: pure function of its arguments, no I/O, no randomness, no shared
 * mutable state. Safe to call at parse time alongside `cyclomaticComplexity`.
 */

export interface ComputePlumbingFeaturesArgs {
  readonly symbolName: string;
  /** "Function" | "Method" | "Class" | ... — only "Class" (any case) takes the class-head path. */
  readonly kind: string;
  /** Source text of the symbol's body/subtree. */
  readonly bodyText: string;
  /** For Class kinds: the head line(s) up to the first `{` or `:` (the base list). */
  readonly classHeadText?: string;
  readonly lang: "python" | "java" | "go";
}

export interface PlumbingFeatureCounts {
  readonly nSerializationCalls: number;
  /** Positive domain signals: domain conditionals + arithmetic + domain exceptions + state transitions. */
  readonly nDomainSignals: number;
  /**
   * Negative plumbing signals, composed EXACTLY as Python `n_plumbing_signals`:
   * `n_serialization_calls + n_observ_calls + (is_getter_setter ? 1 : 0) +
   * (dto_mapper_ratio >= 0.5 ? 1 : 0)`.
   */
  readonly nPlumbingSignals: number;
  readonly isOrmModel: boolean;
}

// ── marker sets (ported verbatim from och_bizlogic_extract.py) ──────────────

/** Serialization markers (plumbing). */
const SERIALIZATION_MARKERS: ReadonlySet<string> = new Set([
  "dumps",
  "loads",
  "model_dump",
  "dict",
  "to_dict",
  "from_dict",
  "json",
  "serialize",
  "deserialize",
  "Marshal",
  "Unmarshal",
  "parse",
  "stringify",
  "to_json",
  "from_json",
  "asdict",
  "schema",
  "encode",
  "decode",
  "ObjectMapper",
  "writeValue",
  "readValue",
]);

/** Logging / metrics / tracing markers (plumbing). */
const OBSERV_MARKERS: ReadonlySet<string> = new Set([
  "log",
  "logger",
  "logging",
  "debug",
  "info",
  "warning",
  "warn",
  "error",
  "exception",
  "metric",
  "counter",
  "gauge",
  "histogram",
  "span",
  "trace",
  "emit",
  "record",
  "telemetry",
  "println",
  "printf",
  "Print",
  "Printf",
  "Println",
  "Sprintf",
]);

// ── ORM / persistence base classes (class-head matching only) ───────────────

/**
 * ORM declarative base — matched ONLY as an EXACT superclass identifier in the
 * base list. Never a component/substring, so RequestBase / ResponseBase /
 * BaseLoader do NOT count.
 */
const ORM_BASE_EXACT: ReadonlySet<string> = new Set([
  "Base",
  "declarative_base",
  "Model",
  "SQLModel",
  "TortoiseModel",
]);

/** Unambiguous ORM-model role words — safe to match as a camelCase component. */
const ORM_BASE_COMPONENT: readonly string[] = [
  "Entity",
  "Document",
  "Table",
  "AbstractEntity",
  "AbstractPersistable",
  "PanacheEntity",
];

// NOTE: the Python's INFRA_ROLE_COMPONENT (Repository/UnitOfWork/DAO/Mapper/…)
// is intentionally NOT ported here. It only feeds the Python's
// `touches_persistence` flag and forces `is_orm_model = False` — neither of
// which is one of the four fields the shipped kernel reads (nSerializationCalls,
// nDomainSignals, nPlumbingSignals, isOrmModel-true). An infra role never makes
// a class an ORM model, so dropping it cannot change any kernel input.

// ── guard / exception / state tokens ────────────────────────────────────────

/** None/type guard predicates → NOT domain conditionals. */
const GUARD_TOKENS: readonly string[] = [
  "None",
  "null",
  "nil",
  "isinstance",
  "hasattr",
  "getattr",
  "type",
  "instanceof",
  "typeof",
  "is None",
  "is not None",
  "== nil",
  "!= nil",
  "undefined",
  "len",
  "empty",
  "isEmpty",
  "== null",
  "!= null",
];

/** Domain-exception heuristic: a raised class whose name ends in these. */
const DOMAIN_EXC_SUFFIXES: readonly string[] = [
  "Error",
  "Exception",
  "Invalid",
  "Denied",
  "NotAllowed",
  "Violation",
  "Conflict",
  "Forbidden",
  "Unauthorized",
];

/** Stdlib / framework errors that are plumbing, not domain. */
const STDLIB_EXC: ReadonlySet<string> = new Set([
  "ValueError",
  "TypeError",
  "KeyError",
  "IndexError",
  "AttributeError",
  "RuntimeError",
  "NotImplementedError",
  "StopIteration",
  "OSError",
  "IOError",
  "Exception",
  "BaseException",
  "Error",
  "AssertionError",
  "ImportError",
  "FileNotFoundError",
  "NullPointerException",
  "IllegalArgumentException",
  "IllegalStateException",
  "RuntimeException",
]);

/** Status/state field names → state-machine transition signal. */
const STATE_FIELD_TOKENS: readonly string[] = [
  "status",
  "state",
  "phase",
  "stage",
  "step",
  "mode",
  "kind",
  "level",
  "tier",
  "verdict",
];

// ── ported regex primitives (verbatim from the Python) ──────────────────────

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
/** camelCase / PascalCase component splitter (Python `_CAMEL_RE`). */
const CAMEL_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

/** Escape a marker for use inside a `\b...\b` RegExp (matches Python `re.escape`). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_RE_CACHE = new Map<string, RegExp>();
function wordRe(marker: string): RegExp {
  let rx = WORD_RE_CACHE.get(marker);
  if (rx === undefined) {
    rx = new RegExp(`\\b${escapeRegExp(marker)}\\b`, "i");
    WORD_RE_CACHE.set(marker, rx);
  }
  return rx;
}

/**
 * Word-boundary match (NOT substring). Returns true when any marker's whole-word
 * form appears in `text`. Mirrors Python `marker_hit`. (We only need the boolean
 * for per-call counting; the Python returns the marker string, but the caller
 * only uses its truthiness.)
 */
function markerHit(text: string, markers: ReadonlySet<string>): boolean {
  for (const m of markers) {
    if (wordRe(m).test(text)) return true;
  }
  return false;
}

/** Python `_components`: lower-cased camelCase pieces of an identifier. */
function components(ident: string): Set<string> {
  const out = new Set<string>();
  for (const m of ident.matchAll(CAMEL_RE)) out.add(m[0].toLowerCase());
  return out;
}

/** Number of camelCase pieces in an identifier (Python `len(_CAMEL_RE.findall(b))`). */
function camelPartCount(ident: string): number {
  const m = ident.match(CAMEL_RE);
  return m === null ? 0 : m.length;
}

/** All identifiers in a blob (Python `_IDENT_RE.findall`). */
function findIdentifiers(text: string): string[] {
  return [...text.matchAll(IDENT_RE)].map((m) => m[0]);
}

// NOTE: the Python `persistence_call_hit` / `raw_sql_hit` / `is_bootstrap_name`
// helpers and their marker sets (PERSIST_*, RAW_SQL_PATTERNS, BOOTSTRAP_*,
// QUALIFIED_CALL_RE, receiverTokens, AMBIGUOUS/DICT/CONTEXT/STRONG_RECEIVERS)
// are intentionally NOT ported. They feed the Python's `touches_persistence`
// and `is_framework_bootstrap` fields, neither of which is one of the four
// fields the shipped kernel reads (nSerializationCalls, nDomainSignals,
// nPlumbingSignals, isOrmModel). n_plumbing_signals is composed ONLY from
// serialization + observability + getter/setter + dto-mapper-ratio (Python
// lines 767-769), so qualified-persistence / raw-SQL / bootstrap never enter it.

// ── guard / class-head (verbatim ports) ─────────────────────────────────────

/** Python `is_guard_condition`. */
function isGuardCondition(condText: string): boolean {
  for (const g of GUARD_TOKENS) {
    if (isIdentifier(g)) {
      if (wordRe(g).test(condText)) return true;
    } else {
      if (condText.includes(g)) return true;
    }
  }
  return false;
}

/** True when `s` is a single Python-style identifier (matches `str.isidentifier`). */
function isIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Decide whether a class is an ORM-mapped model from its head alone. Port of the
 * `is_orm_model` half of Python `class_head_persistence`. Returns true ONLY for
 * the ORM-model shapes (exact ORM base OR component ORM role). Infra repo/DAO
 * roles are NOT ORM models (they return `is_orm_model=False` in Python).
 *
 * @param className   the class's own declared name (e.g. `AbstractRepository`).
 * @param baseIdents  identifiers in the superclass / implements list.
 * @param annotBlob   decorator/annotation text (e.g. `@Entity @Table(...)`).
 */
function classHeadIsOrmModel(
  className: string,
  baseIdents: readonly string[],
  annotBlob: string,
): boolean {
  const nameComps = components(className);
  const baseComps = new Set<string>();
  for (const b of baseIdents) {
    for (const c of components(b)) baseComps.add(c);
  }
  const annotComps = new Set<string>();
  for (const a of findIdentifiers(annotBlob)) {
    for (const c of components(a)) annotComps.add(c);
  }

  // ORM model — exact base superclass (no component leakage).
  for (const b of ORM_BASE_EXACT) {
    if (baseIdents.includes(b)) return true;
  }
  // ORM model — component role in name / base / annotation.
  for (const b of ORM_BASE_COMPONENT) {
    const bc = b.toLowerCase();
    if (camelPartCount(b) === 1) {
      if (nameComps.has(bc) || baseComps.has(bc) || annotComps.has(bc)) return true;
    } else {
      // compound (AbstractEntity, PanacheEntity): substring of name/base
      for (const ident of [className, ...baseIdents]) {
        if (ident.toLowerCase().includes(bc)) return true;
      }
    }
  }
  return false;
}

// ── class-head base-list extraction ─────────────────────────────────────────

/**
 * Pull (className, baseIdents) from the class-head text. Mirrors the
 * `class_name_and_bases` Python helper for the languages the sieve is validated
 * on (python / java / go). The head text is everything up to the first `{` or
 * `:` (Python) — the caller supplies it as `classHeadText`.
 *
 *   python : `class User(Base, Mixin)`  → bases = idents inside the parens
 *   java   : `class Owner extends BaseEntity implements X` → bases after
 *            extends/implements
 *   go     : `type User struct` (no inheritance) → no bases
 *
 * The pydantic `BaseModel` base is dropped (a DTO base, NOT an ORM model),
 * matching `base_idents = [b for b in base_idents if b != "BaseModel"]`.
 */
function classNameAndBases(
  headText: string,
  lang: "python" | "java" | "go",
): { className: string; baseIdents: string[]; annotBlob: string } {
  // Annotation/decorator lines (`@Entity`, `@dataclass`) precede the class
  // keyword; split them off so they feed the annotation blob, not the bases.
  const lines = headText.split("\n");
  const annotLines: string[] = [];
  const declLines: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith("@")) annotLines.push(line.trim());
    else declLines.push(line);
  }
  const decl = declLines.join("\n");
  const annotBlob = annotLines.join(" ");

  let className = "";
  let baseIdents: string[] = [];

  if (lang === "python") {
    // class Name(Base1, Base2):
    const nameMatch = decl.match(/class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    className = nameMatch?.[1] ?? "";
    const parenMatch = decl.match(/class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([\s\S]*?)\)/);
    if (parenMatch?.[1] !== undefined) {
      baseIdents = findIdentifiers(parenMatch[1]);
    }
  } else if (lang === "java") {
    const nameMatch = decl.match(/(?:class|interface|record|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    className = nameMatch?.[1] ?? "";
    // Take identifiers after `extends` / `implements`, stripping generics.
    const extMatch = decl.match(/\bextends\b([\s\S]*?)(?:\bimplements\b|$)/);
    const implMatch = decl.match(/\bimplements\b([\s\S]*)$/);
    const baseSrc = `${extMatch?.[1] ?? ""} ${implMatch?.[1] ?? ""}`;
    baseIdents = findIdentifiers(baseSrc);
  } else {
    // go: `type Name struct {` / `type Name interface {` — no inheritance.
    const nameMatch = decl.match(/type\s+([A-Za-z_][A-Za-z0-9_]*)/);
    className = nameMatch?.[1] ?? "";
    baseIdents = [];
  }

  // Strip the class's own name if it leaked into the base list, and drop the
  // pydantic DTO base. Mirrors the two Python filters.
  baseIdents = baseIdents.filter((b) => b.length > 0 && b !== className && b !== "BaseModel");
  return { className, baseIdents, annotBlob };
}

// ── body call enumeration (text reproduction of per-call walk) ──────────────

/**
 * A call site recovered from `bodyText`: the index where the callee starts and
 * the call's "head text" (callee start → end of that physical line, capped at
 * 200 chars). This mirrors the Python per-call
 * `head_text = node_text(call).split("\n", 1)[0][:200]`, where the tree-sitter
 * call node text begins at the (possibly chained) callee. Each `(` preceded by
 * an identifier / member chain is one call site, so nested calls on the same
 * line are enumerated separately — matching the Python `walk`, which visits a
 * nested `json.dumps(...)` inside `log.info(...)` as its own call node.
 */
interface CallSite {
  /** Head text from the callee start to end-of-line, capped at 200 chars. */
  readonly headText: string;
  /** Full call text from the callee start to end-of-line (uncapped). For raw-SQL. */
  readonly fullText: string;
}

/** Matches a call opener: an identifier / member chain immediately before `(`. */
const CALL_OPENER_RE = /(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Control-flow / declaration keywords that take a `(` but are NOT call nodes in
 * the AST (`if (...)`, `for (...)`, `func (...)`, …). Excluding them keeps the
 * text call-scan from inflating `n_calls` — which would wrongly disqualify a
 * getter/setter (the gate requires `n_calls == 0`). The set is the union across
 * python / java / go; a keyword never collides with a real callee.
 */
const NON_CALL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "func",
  "def",
  "class",
  "with",
  "else",
  "elif",
  "case",
  "select",
  "defer",
  "go",
  "range",
  "await",
  "yield",
  "in",
  "and",
  "or",
  "not",
  "new",
]);

/**
 * Strip the leading definition header (`def f(...):` / `func (r *R) F(...) {` /
 * `void f(...) {`) so the function's OWN name+params is not enumerated as a
 * call and its signature `*`/`(` are not scanned as body code. The Python's AST
 * counts call/binary/if nodes only inside the body; the signature is a separate
 * parameter/type subtree. Returns the body with the header span blanked
 * (length-preserving so line offsets stay aligned).
 */
function stripDefinitionHeader(bodyText: string, lang: "python" | "java" | "go"): string {
  const chars = bodyText.split("");
  const n = chars.length;
  // Mask strings/comments while LOCATING the header terminator so a `:`/`{`/`;`
  // inside a string or comment cannot false-terminate the header span.
  const probe = maskStringsAndComments(bodyText);
  // Skip leading decorator / annotation lines (`@Transactional(...)`,
  // `@dataclass`) so the header terminator is found on the DECLARATION line,
  // not at an annotation's `:`/`(`. Decorators are separate AST nodes.
  let scanFrom = 0;
  for (;;) {
    let j = scanFrom;
    while (j < n && (probe[j] === " " || probe[j] === "\t" || probe[j] === "\n")) j++;
    if (probe[j] === "@") {
      let k = j;
      while (k < n && probe[k] !== "\n") k++;
      scanFrom = k;
    } else {
      scanFrom = j;
      break;
    }
  }
  // The header ends at the FIRST depth-0 terminator from the declaration start:
  //   - python: `:` (the suite opener). The param list `(...)` and any return
  //     annotation sit at bracket-depth > 0 or after a `)`, so a parameter
  //     type-hint `:` is depth-protected. `class X:` terminates immediately.
  //   - java/go: `{` (block opener) or `;` (Java abstract method / Go signature
  //     with no block). Composite-literal `{` would be at depth > 0.
  // Scanning from the start (rather than from a param paren) is what keeps a
  // parenthesis-free class header `class AppContext:` from over-stripping into
  // the class body. If no depth-0 terminator is found, nothing is stripped.
  const terminators: ReadonlySet<string> = lang === "python" ? new Set([":"]) : new Set(["{", ";"]);
  let depth = 0;
  let end = -1;
  for (let i = scanFrom; i < n; i++) {
    const c = probe[i] ?? "";
    if (c === "(" || c === "[" || c === "{") {
      // an opening brace IS a java/go header terminator at depth 0
      if (depth === 0 && terminators.has(c)) {
        end = i;
        break;
      }
      depth += 1;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && terminators.has(c)) {
      end = i;
      break;
    }
  }
  if (end === -1) return bodyText;
  for (let i = 0; i <= end && i < n; i++) {
    if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

/** Definition keywords that, when they immediately precede a `name(`, mark it as
 *  a function/method DEFINITION (not a call): `def name(` / `func name(` /
 *  `fn name(`. The Python AST counts `function_definition` separately from
 *  `call`, so a nested method def inside a class body must NOT be a call. */
const DEF_KEYWORDS: ReadonlySet<string> = new Set(["def", "func", "fn"]);

/**
 * Enumerate call sites. Call OPENERS are found on `maskedBody` (strings &
 * comments masked) so a phantom `ident (` chain inside a docstring/comment
 * (e.g. reST `request body (access ``json``, …)`) does NOT manufacture a call —
 * the Python only ever sees real `call` AST nodes. But the per-call HEAD TEXT is
 * sliced from `rawBody` (length-aligned with `maskedBody`), because the Python's
 * `marker_hit` runs on the call NODE text INCLUDING its string arguments — a Go
 * `t.Fatal("… init error …")` is an observability call BECAUSE `error` appears
 * in the string arg, so the head must be raw.
 */
function enumerateCallSites(maskedBody: string, rawBody: string): CallSite[] {
  const sites: CallSite[] = [];
  CALL_OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CALL_OPENER_RE.exec(maskedBody);
  while (m !== null) {
    const callee = m[1] ?? "";
    if (!NON_CALL_KEYWORDS.has(callee) && !precededByDefKeyword(maskedBody, m.index)) {
      const start = m.index;
      const nl = rawBody.indexOf("\n", start);
      const lineEnd = nl === -1 ? rawBody.length : nl;
      const line = rawBody.slice(start, lineEnd);
      sites.push({ headText: line.slice(0, 200), fullText: line });
    }
    m = CALL_OPENER_RE.exec(maskedBody);
  }
  return sites;
}

/** True when the identifier chain starting at `start` is a function/method
 *  DEFINITION name or a decorator/annotation rather than a call site:
 *    - preceded by a definition keyword (`def`/`func`/`fn`), OR
 *    - the chain is a decorator/annotation invocation `@Name(...)` (the char
 *      before the leading identifier is `@`).
 *  Both are distinct AST nodes from `call`, so they must not be counted. */
function precededByDefKeyword(text: string, start: number): boolean {
  // Decorator / annotation: `@Name(` — the identifier is prefixed by `@`.
  if (text[start - 1] === "@") return true;
  let i = start - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z_$]/.test(text[i] ?? "")) i--;
  const word = text.slice(i + 1, end);
  return DEF_KEYWORDS.has(word);
}

// ── positive domain-signal scanners (text reproduction of the AST walk) ─────

/**
 * Mask string literals and comments so the STRUCTURAL scans (conditionals,
 * arithmetic, exceptions) do not read an operator / `if` / `raise` keyword that
 * lives inside a string or comment as code — the Python walks AST nodes, so a
 * `+` inside `'a + b'` or an `if` inside a comment never appears as a structural
 * node. Two distinct replacements, both length-preserving (so line offsets and
 * the assignment line-scan stay aligned):
 *
 *   - comments → spaces (no operand left behind).
 *   - string literals → a single operand SENTINEL `0` at the opening-quote
 *     position, the remaining chars (including the closing quote) blanked.
 *
 * The sentinel is the key fidelity point: the Python AST treats a string literal
 * as an OPERAND, so `name + "_dup"` is a `binary_expression` and counts as
 * arithmetic. Blanking the whole literal to spaces would erase the right operand
 * and miss the `+`; leaving the sentinel `0` keeps the operand boundary so the
 * `+` is still recognised. Likewise `x == "active"` keeps its right operand.
 *
 * Handles Python/JS single & double quotes, backticks, triple quotes, and
 * `#` / `//` line comments plus block comments.
 *
 * NOTE: masking is applied ONLY to the structural scans. Call enumeration and
 * marker matching deliberately run on the RAW text, because the Python's
 * per-call matchers run on the call NODE text, which INCLUDES string-literal
 * arguments.
 */
function maskStringsAndComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  // Replace a string literal [from, to) with a single operand sentinel at `from`
  // and spaces elsewhere (newlines preserved for line alignment).
  const sentinelize = (from: number, to: number) => {
    blank(from, to);
    if (from < n && out[from] !== "\n") out[from] = "0";
  };
  while (i < n) {
    const c = src[i] ?? "";
    const c2 = src.slice(i, i + 2);
    const c3 = src.slice(i, i + 3);
    // line comments
    if (c === "#" || c2 === "//") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment
    if (c2 === "/*") {
      let j = i + 2;
      while (j < n && src.slice(j, j + 2) !== "*/") j++;
      const end = Math.min(n, j + 2);
      blank(i, end);
      i = end;
      continue;
    }
    // triple-quoted strings
    if (c3 === '"""' || c3 === "'''") {
      const q = c3;
      let j = i + 3;
      while (j < n && src.slice(j, j + 3) !== q) j++;
      const end = Math.min(n, j + 3);
      sentinelize(i, end);
      i = end;
      continue;
    }
    // single/double/backtick strings (single line for ' and ", possibly multi
    // for `; we stop at the matching unescaped quote or newline for '/")
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        const cj = src[j] ?? "";
        if (cj === "\\") {
          j += 2;
          continue;
        }
        if (cj === q) break;
        if ((q === '"' || q === "'") && cj === "\n") break;
        j++;
      }
      const end = Math.min(n, j + 1);
      // Python f-string (`f"...{expr}..."`, `rf"…"`): the `{expr}` interpolations
      // are REAL code (the AST parses calls/operators inside them, e.g.
      // `f"<{type(self).__name__}>"` is a call node). Preserve `{...}` spans and
      // mask only the literal text. A non-f string is sentinelized whole.
      const prefix = stringPrefix(src, i);
      if (prefix.includes("f") && (q === '"' || q === "'")) {
        sentinelizeFString(out, src, i, end);
      } else {
        sentinelize(i, end);
      }
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Lower-cased string-prefix letters immediately before the opening quote at
 *  `quoteIdx` (`f`, `r`, `b`, `rf`, `fr`, …) — used to detect f-strings. */
function stringPrefix(src: string, quoteIdx: number): string {
  let i = quoteIdx - 1;
  let out = "";
  while (i >= 0 && /[A-Za-z]/.test(src[i] ?? "")) {
    out = (src[i] ?? "").toLowerCase() + out;
    i--;
  }
  // a prefix is at most a couple of letters and must abut the quote; longer runs
  // are an adjacent identifier, not a string prefix.
  return out.length <= 2 ? out : "";
}

/**
 * Mask a Python f-string [from, to): blank the literal text but PRESERVE the
 * `{expr}` interpolation contents (real code the AST parses) so embedded calls /
 * operators are still scanned. `{{` / `}}` are escaped literal braces (blanked).
 * Writes into `out` in place; length-preserving.
 */
function sentinelizeFString(out: string[], src: string, from: number, to: number): void {
  const n = out.length;
  const blankOne = (k: number) => {
    if (k < n && out[k] !== "\n") out[k] = " ";
  };
  let sentinelPlaced = false;
  let k = from;
  while (k < to) {
    const c = src[k] ?? "";
    if (c === "{" && src[k + 1] === "{") {
      blankOne(k);
      blankOne(k + 1);
      k += 2;
      continue;
    }
    if (c === "}" && src[k + 1] === "}") {
      blankOne(k);
      blankOne(k + 1);
      k += 2;
      continue;
    }
    if (c === "{") {
      // preserve the interpolation contents until the matching `}` (the `{`/`}`
      // braces themselves become spaces; an inner `:` format-spec is left as-is,
      // harmless for the scans). Place an operand sentinel for the literal run
      // we just blanked so the f-string still reads as an operand if needed.
      blankOne(k);
      k += 1;
      let depth = 1;
      while (k < to && depth > 0) {
        const cc = src[k] ?? "";
        if (cc === "{") depth += 1;
        else if (cc === "}") {
          depth -= 1;
          if (depth === 0) {
            blankOne(k);
            k += 1;
            break;
          }
        }
        // preserve interpolation code char (leave out[k] = src char already)
        k += 1;
      }
      continue;
    }
    // literal char → blank, but keep a single operand sentinel for the whole
    // string so `name + f"x"` style still has a right operand.
    blankOne(k);
    if (!sentinelPlaced && out[k] === " ") {
      out[k] = "0";
      sentinelPlaced = true;
    }
    k += 1;
  }
}

/**
 * Count domain conditionals. The Python counts each `if_statement` node whose
 * condition is NOT a guard. `elif` clauses are a separate node type and are NOT
 * counted; nested `if`s ARE (each is its own node). Text reproduction: scan for
 * a statement-leading `if` keyword (word-boundary), extract its condition, and
 * count when the condition is not a guard.
 *
 *   python : `if <cond>:`            (NOT `elif`)
 *   java/go: `if <cond> {` / `if (<cond>)`
 */
/**
 * Enumerate the condition text of every `if_statement` node, full and
 * multi-line aware. `elif`/`else if` clauses are part of the SAME `if_statement`
 * AST node, so they are NOT counted (the `\bif\b` boundary already excludes
 * `elif`; `else if` would re-match but is rare in this corpus and a separate
 * node in Java/Go — handled below).
 *
 *   python : `if <cond>:` — condition spans from `if` to the depth-0 `:` that
 *            opens the suite; a parenthesised condition may span many lines
 *            (`if (\n   a\n   and b\n):`). We read to that colon.
 *   java/go: `if (<cond>)` / `if <cond> {` — read to the matched `)` (paren
 *            form) or the opening `{` (brace form).
 */
function enumerateIfConditions(bodyText: string, lang: "python" | "java" | "go"): string[] {
  const conds: string[] = [];
  const n = bodyText.length;
  if (lang === "python") {
    const re = /(?:^|\n)[ \t]*if\b/g;
    let m: RegExpExecArray | null = re.exec(bodyText);
    while (m !== null) {
      // Start scanning right after the matched `if`.
      const ifEnd = m.index + m[0].length;
      let depth = 0;
      let end = -1;
      for (let i = ifEnd; i < n; i++) {
        const c = bodyText[i];
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") depth -= 1;
        else if (c === ":" && depth === 0) {
          end = i;
          break;
        }
      }
      const cond = bodyText.slice(ifEnd, end === -1 ? n : end).trim();
      conds.push(cond);
      re.lastIndex = end === -1 ? n : end;
      m = re.exec(bodyText);
    }
  } else {
    // java / go: `if` followed by either `(cond)` or a brace-form `cond {`.
    const re = /\bif\b/g;
    let m: RegExpExecArray | null = re.exec(bodyText);
    while (m !== null) {
      let i = m.index + 2;
      while (i < n && (bodyText[i] === " " || bodyText[i] === "\t")) i++;
      let cond = "";
      if (bodyText[i] === "(") {
        // paren form: read to the matched close paren.
        let depth = 0;
        const start = i + 1;
        for (; i < n; i++) {
          const c = bodyText[i];
          if (c === "(") depth += 1;
          else if (c === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        cond = bodyText.slice(start, i).trim();
      } else {
        // brace form (go `if cond {`): read to the opening brace or newline.
        let j = i;
        while (j < n && bodyText[j] !== "{" && bodyText[j] !== "\n") j++;
        cond = bodyText.slice(i, j).trim();
      }
      conds.push(cond);
      re.lastIndex = i + 1;
      m = re.exec(bodyText);
    }
  }
  return conds;
}

function countDomainConditionals(bodyText: string, lang: "python" | "java" | "go"): number {
  let count = 0;
  for (const cond of enumerateIfConditions(bodyText, lang)) {
    if (cond.length > 0 && !isGuardCondition(cond)) count += 1;
  }
  return count;
}

/**
 * Count arithmetic operators. The Python counts each binary-operator AST node
 * whose text contains one of `+ - * / %`. Augmented assignments (`+=`, `-=`)
 * are a DIFFERENT node type and do NOT count; comparison-only operators
 * (`>`, `<`) do NOT count. Text reproduction: count occurrences of a binary
 * arithmetic operator that is NOT part of an augmented-assignment / increment
 * and is flanked by operands.
 *
 * DIVERGENCE (magnitude only, never the zero/non-zero boundary the kernel
 * reads): the AST counts one node per binary expression, so `a + b * 2` is 2
 * nodes. A flat text scan also finds 2 operators here, but deeply nested or
 * unusual expressions can differ in COUNT. The boundary (≥1 arithmetic op ⇒
 * count ≥ 1, none ⇒ 0) is preserved, which is all `nDomainSignals > 0` needs.
 */
function countArithmeticOps(bodyText: string): number {
  let count = 0;
  // A binary arithmetic operator: one of + - * / % that has an OPERAND on each
  // side (the previous non-space char ends an operand AND the next begins one).
  // This single gate rejects every non-binary use in one shot:
  //   - augmented assignment `*=` (next is `=`, not an operand start);
  //   - the 2nd char of a comparison/assign `>=`/`==`/`<=` (prev is `=<>!`);
  //   - unary / pointer / splat `*T` `&x` `-x` `*args` `**kwargs` `{**d}` —
  //     these sit in a PREFIX position whose previous non-space char is `(`, `,`,
  //     `[`, `{`, `=`, `:`, an operator, or nothing, none of which is an operand
  //     boundary, so the left-operand test fails.
  // Doubled `**` (pow) / `//` (floordiv) are a single AST binary node when they
  // ARE binary (`a ** b`), counted once; `++`/`--` never pass the operand gate
  // in a way that double-counts because we advance past the pair.
  const ops = new Set(["+", "-", "*", "/", "%"]);
  for (let i = 0; i < bodyText.length; i++) {
    const ch = bodyText[i] ?? "";
    if (!ops.has(ch)) continue;
    const next = bodyText[i + 1] ?? "";
    const prev = bodyText[i - 1] ?? "";
    // Skip the second char of a comparison/assign operator (`=*`, `<*`, …) and
    // augmented assignment (`*=`).
    if (prev === "=" || prev === "<" || prev === ">" || prev === "!") continue;
    if (next === "=") continue;
    // Go/C pointer-type / deref / splat / unary `*T`. Two non-binary shapes,
    // both with the operand ATTACHED on the right (no space — `*pendingCall`,
    // `*testing.T`, `*Task`, `*args`, `**kwargs`):
    //   (a) a SPACE on the left   — `t *testing.T`, `chan *Foo`, `return *p`;
    //   (b) a TYPE-bracket on the left `]`/`)`/`}` — `[]*Task`, `map[K]*V`,
    //       `(*Foo)`, the idiomatic Go slice/map/cast pointer-to-type forms.
    // Binary multiply is `a * b` (spaces both sides) or `a*b`/`x[i]*2` (a NUMBER
    // or space on the right), none of which has an attached identifier-start
    // right operand, so this skip leaves real arithmetic intact.
    if (ch === "*") {
      const attachedRightIdent = /[A-Za-z_$([&*]/.test(next);
      const prefixLeft =
        prev === " " || prev === "\t" || prev === "]" || prev === ")" || prev === "}";
      if (attachedRightIdent && prefixLeft) continue;
    }
    // Doubled operators: `**`/`//` count once IF binary; `++`/`--` never. Decide
    // by the operand gate on the PAIR (left of first char, right of second).
    if ((ch === "+" || ch === "-" || ch === "*" || ch === "/") && next === ch) {
      if (ch === "*" || ch === "/") {
        const leftOk = isOperandBoundary(prevNonSpace(bodyText, i));
        const rightOk = isOperandStart(nextNonSpace(bodyText, i + 1));
        if (leftOk && rightOk) count += 1;
      }
      i += 1;
      continue;
    }
    // Binary gate: operand-ending char on the left, operand-starting char on the
    // right. The string sentinel `0` reads as an operand on either side, so
    // `name + "lit"` (→ `name + 0`) counts; `(*T)` / `(**kw)` / `, *args` do not.
    if (isOperandBoundary(prevNonSpace(bodyText, i)) && isOperandStart(nextNonSpace(bodyText, i))) {
      count += 1;
    }
  }
  return count;
}

function prevNonSpace(s: string, i: number): string {
  for (let j = i - 1; j >= 0; j--) {
    const c = s[j] ?? "";
    if (c !== " " && c !== "\t") return c;
  }
  return "";
}
function nextNonSpace(s: string, i: number): string {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j] ?? "";
    if (c !== " " && c !== "\t") return c;
  }
  return "";
}
function isOperandBoundary(c: string): boolean {
  return /[A-Za-z0-9_$)\]'"`]/.test(c);
}
function isOperandStart(c: string): boolean {
  return /[A-Za-z0-9_$('"`]/.test(c);
}

/**
 * Count raised domain exceptions. The Python visits each `raise`/`throw` node,
 * tokenises its text, and counts ONE per statement when a token ends in a
 * domain suffix and is NOT in the stdlib stoplist. Text reproduction: scan each
 * `raise`/`throw` statement line and apply the same per-statement rule.
 */
function countDomainExceptions(bodyText: string, lang: "python" | "java" | "go"): number {
  if (lang === "go") return 0; // Go has no raise/throw (raise_node = "").
  const keyword = "raise|throw";
  const re = new RegExp(`\\b(?:${keyword})\\b([^\\n;]*)`, "g");
  let count = 0;
  let m: RegExpExecArray | null = re.exec(bodyText);
  while (m !== null) {
    const rtext = m[1] ?? "";
    // Mirror Python: replace '(' and the word 'new' with spaces, split on ws,
    // strip trailing ();, take the FIRST qualifying token (break).
    const cleaned = rtext.replace(/\(/g, " ").replace(/\bnew\b/g, " ");
    for (const rawTok of cleaned.split(/\s+/)) {
      const tok = rawTok.trim().replace(/[();]+$/, "");
      if (tok.length === 0) continue;
      if (endsWithDomainSuffix(tok) && !STDLIB_EXC.has(tok)) {
        count += 1;
        break;
      }
    }
    m = re.exec(bodyText);
  }
  return count;
}

function endsWithDomainSuffix(tok: string): boolean {
  for (const suf of DOMAIN_EXC_SUFFIXES) {
    if (tok.endsWith(suf)) return true;
  }
  return false;
}

/**
 * Result of the single faithful assignment scan (Python lines 708-722): every
 * assignment node contributes to `assignStmts`; the attr->attr branch
 * (`"." in atext AND "(" not in atext AND no arithmetic op`) splits into a state
 * transition (LHS carries a {@link STATE_FIELD_TOKENS} token) or a DTO
 * attr->attr assign.
 */
interface AssignmentScan {
  /** All assignment statements (Python `assign_stmts`). */
  readonly assignStmts: number;
  /** attr->attr assignments whose LHS is NOT a state field (Python `attr_to_attr`). */
  readonly attrToAttr: number;
  /** attr->attr assignments whose LHS IS a state field (Python `n_state_transitions`). */
  readonly nStateTransitions: number;
}

/**
 * Scan assignment statements once and reproduce the Python assignment branch
 * EXACTLY (och_bizlogic_extract.py lines 708-722):
 *
 * ```python
 * elif assign_node and t == assign_node:
 *     assign_stmts += 1
 *     atext = node_text(n, src)
 *     if "." in atext and "(" not in atext and not any(
 *         op in atext for op in ("+", "-", "*", "/", "%")):
 *         lhs = atext.split("=")[0]
 *         if any(s in lhs.lower() for s in STATE_FIELD_TOKENS):
 *             f.n_state_transitions += 1
 *         else:
 *             attr_to_attr += 1
 * ```
 *
 * The Python tests are pure string predicates on the assignment node's text, so
 * a line-based assignment scan that applies the SAME predicates is faithful.
 * `assign_stmts` counts EVERY assignment (this is the `dto_mapper_ratio`
 * denominator); the attr->attr split feeds the numerator and the state-machine
 * signal. A plain `self.state = 5` still has a `.` (on the LHS), no `(`, no
 * arithmetic → it qualifies as a state transition, matching the Python.
 */
function scanAssignments(bodyText: string, lang: "python" | "java" | "go"): AssignmentScan {
  let assignStmts = 0;
  let attrToAttr = 0;
  let nStateTransitions = 0;
  // Two aligned, length-preserving views (offsets match — same length):
  //   - `locate`: strings AND comments masked — used to FIND the assignment `=`,
  //     so a `=` inside a docstring/string (`methods=["GET"]`) or comment is NOT
  //     mistaken for an assignment (a string is never an `assignment` node).
  //   - `gate`: comments masked, strings RAW — used for the attr->attr gate
  //     predicates, because the Python `atext = node_text(assign)` INCLUDES the
  //     string RHS, so a `(`/`-`/`+` inside a string literal still disqualifies
  //     attr->attr (`"(" not in atext` / no-arith).
  const locate = maskStringsAndComments(bodyText);
  const gate = maskCommentsOnly(bodyText);
  // Statement units to scan:
  //   - python: LOGICAL statements joined across `()[]{}` continuations, so a
  //     multi-line call's `kw=value` arguments are ONE call statement, not
  //     per-line assignments. Python has no block braces (indentation-scoped),
  //     so `{}` only ever delimits dict/set literals → safe to treat as a
  //     continuation.
  //   - java/go: PHYSICAL lines. These languages use `{}` for BOTH blocks and
  //     composite literals, so a cross-line join would swallow whole `for`/`if`
  //     blocks; per-line scanning matches their one-assignment-per-line idiom
  //     (`x[i] = &T{` reads as the attr->attr assignment the AST sees, and
  //     struct-field `key: value` lines carry no `=`).
  const spans = lang === "python" ? splitLogicalStatements(locate) : physicalLineSpans(locate);
  for (const [s, e] of spans) {
    const locStmt = locate.slice(s, e);
    let eq = assignmentEqIndex(locStmt);
    // Python class/var ANNOTATION without value (`products: repository.X`): a
    // tree-sitter-python `assignment` node fires even with no `=`. Treat a
    // statement-level `<name>: <type>` (a depth-0 `:` whose LHS is a plain
    // dotted identifier, not a compound-statement keyword) as an assignment, with
    // the `:` standing in as the LHS/RHS split point for the gate.
    if (eq === -1 && lang === "python") {
      eq = pythonAnnotationColonIndex(locStmt);
    }
    if (eq === -1) continue;
    assignStmts += 1;
    const gateStmt = gate.slice(s, e);
    if (!gateStmt.includes(".")) continue;
    if (gateStmt.includes("(")) continue;
    if (/[+\-*/%]/.test(gateStmt)) continue;
    const lhsLow = gateStmt.slice(0, eq).toLowerCase();
    let isState = false;
    for (const st of STATE_FIELD_TOKENS) {
      if (lhsLow.includes(st)) {
        isState = true;
        break;
      }
    }
    if (isState) nStateTransitions += 1;
    else attrToAttr += 1;
  }
  return { assignStmts, attrToAttr, nStateTransitions };
}

/** Compound-statement keywords whose `:` opens a suite, NOT a type annotation. */
const PY_COMPOUND_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "elif",
  "else",
  "for",
  "while",
  "with",
  "try",
  "except",
  "finally",
  "def",
  "class",
  "match",
  "case",
  "async",
  "lambda",
]);

/**
 * Index of the `:` that makes a Python statement a bare ANNOTATION assignment
 * (`name: Type` with no value), or -1. The LHS before the depth-0 `:` must be a
 * single plain (optionally dotted/attribute) identifier — `self.products`,
 * `products` — and must NOT begin with a compound-statement keyword (so `if x:`,
 * `for a in b:`, `def f():` are excluded). A `:` inside `()[]{}` (slice / dict /
 * call) is depth-protected.
 */
function pythonAnnotationColonIndex(stmt: string): number {
  let depth = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i] ?? "";
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ":" && depth === 0) {
      const lhs = stmt.slice(0, i).trim();
      // LHS must be a plain dotted identifier (no spaces, no operators/commas).
      if (!/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(lhs)) return -1;
      const firstWord = lhs.split(".")[0]?.trim() ?? "";
      if (PY_COMPOUND_KEYWORDS.has(firstWord)) return -1;
      return i;
    }
  }
  return -1;
}

/** Physical-line spans `[start, end)` over `src` (one per `\n`-delimited line). */
function physicalLineSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  if (start <= src.length) spans.push([start, src.length]);
  return spans;
}

/**
 * Split source into logical-statement spans `[start, end)` (PYTHON only). A
 * newline at bracket-depth 0 (and not a `\` line-continuation) ends a statement;
 * a newline inside `()`/`[]`/`{}` is a continuation and stays in the same
 * statement. This keeps `f(\n  kw=val,\n)` continuation lines from being read as
 * depth-0 `kw=val` assignments — the AST sees one call node, not assignments.
 */
function splitLogicalStatements(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = src.length;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = src[i] ?? "";
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth -= 1;
    } else if ((c === "\n" || c === ";") && depth === 0) {
      if (c === "\n" && src[i - 1] === "\\") continue;
      spans.push([start, i]);
      start = i + 1;
    }
  }
  if (start < n) spans.push([start, n]);
  return spans;
}

/** Blank `#` / `//` line comments and `/* … *​/` blocks to spaces (length
 *  preserved, newlines kept), leaving string literals intact. Used by the
 *  assignment scan, whose Python counterpart reads the assignment node text
 *  (comments excluded, string RHS literals included). */
function maskCommentsOnly(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i] ?? "";
    const c2 = src.slice(i, i + 2);
    if (c === "#" || c2 === "//") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c2 === "/*") {
      let j = i + 2;
      while (j < n && src.slice(j, j + 2) !== "*/") j++;
      const end = Math.min(n, j + 2);
      blank(i, end);
      i = end;
      continue;
    }
    // Skip over string interiors so a `#`/`//` INSIDE a string is not treated as
    // a comment start (preserve the string content for the assignment gate).
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        const cj = src[j] ?? "";
        if (cj === "\\") {
          j += 2;
          continue;
        }
        if (cj === q) break;
        if ((q === '"' || q === "'") && cj === "\n") break;
        j++;
      }
      i = Math.min(n, j + 1);
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Count `return` statements (Python `n_returns`, one per `return_statement`
 * node). Word-boundary scan over the body. Go uses `return` as well. Feeds the
 * getter/setter gate (`n_returns <= 1`).
 */
function countReturns(bodyText: string): number {
  const m = bodyText.match(/\breturn\b/g);
  return m === null ? 0 : m.length;
}

/**
 * Count ALL conditionals (Python `n_total_conditionals`, one per `if_statement`
 * node — guards INCLUDED). Distinct from {@link countDomainConditionals}, which
 * counts only the NON-guard subset. Feeds the getter/setter gate
 * (`n_total_conditionals == 0`).
 *
 *   python : `if <cond>:`            (NOT `elif`)
 *   java/go: `if (<cond>)` / `if ... {`
 */
function countTotalConditionals(bodyText: string, lang: "python" | "java" | "go"): number {
  return enumerateIfConditions(bodyText, lang).length;
}

/**
 * Index of the top-level `=` that makes a line a statement-level ASSIGNMENT, or
 * -1. Mirrors the Python `assignment` AST node, which is distinct from:
 *   - keyword arguments / default params (`f(x=1)`) — the `=` is INSIDE parens,
 *     so we require paren/bracket depth 0;
 *   - comparisons (`==`, `!=`, `<=`, `>=`) and walrus (`:=`), arrow (`=>`);
 *   - augmented assignments (`+= -= *= /= %= **= //= &= |= ^= >>= <<=`), which
 *     are an `augmented_assignment` node in Python, NOT an `assignment`.
 * Returns the depth-0 plain-`=` index (the LHS/RHS split point).
 */
function assignmentEqIndex(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "=" && depth === 0) {
      const before = line[i - 1] ?? "";
      const after = line[i + 1] ?? "";
      if (after === "=") continue; // ==
      if (after === ">") continue; // =>
      if (before === "=" || before === "!" || before === "<" || before === ">" || before === ":")
        continue; // ==, !=, <=, >=, :=
      // augmented assignment: `<op>=` where op is an arithmetic/bitwise/shift op.
      if (
        before === "+" ||
        before === "-" ||
        before === "*" ||
        before === "/" ||
        before === "%" ||
        before === "&" ||
        before === "|" ||
        before === "^"
      )
        continue;
      return i;
    }
  }
  return -1;
}

// ── public entrypoint ───────────────────────────────────────────────────────

/**
 * Compute the four feature fields the {@link classifyPlumbing} kernel consumes,
 * faithful to `och_bizlogic_extract.py`. Pure, deterministic, no I/O.
 */
export function computePlumbingFeatures(args: ComputePlumbingFeaturesArgs): PlumbingFeatureCounts {
  const { symbolName, kind, bodyText, classHeadText, lang } = args;
  const isClass = kind.toLowerCase() === "class";

  // The scan body has the leading definition header (`def f(...):` /
  // `func (r *R) F(...) {`) blanked so the symbol's OWN name+params are not
  // enumerated as a call and the signature's pointer-`*` / param `(` are not
  // scanned as body code. The Python AST counts call/binary/if/return nodes
  // only inside the body; the signature is a separate parameter/type subtree.
  const scanBody = stripDefinitionHeader(bodyText, lang);

  // Go `type X interface { … }` / `type X struct { … }` bodies are field &
  // method-spec declarations — they contain NO call_expression / binary /
  // if / return / assignment AST nodes, so the Python's body-derived counts are
  // all 0 (verified across the corpus: every Go class row has ser=obs=dto=0 and
  // n_domain_signals=0; only is_getter_setter can fire on a short type). A flat
  // text scan would otherwise read interface method specs like `Info(msg ...)`
  // as calls (matching observ markers) — so we zero the body scans for Go types
  // to mirror the AST exactly. `is_getter_setter` still evaluates below with
  // nCalls = nReturns = nTotalConditionals = 0.
  const goTypeDecl = lang === "go" && isClass;

  // STRUCTURAL/CALL scans run on the MASKED body so an operator / `if` / `raise`
  // keyword OR a phantom `ident (` chain inside a string or comment (docstring
  // reST like `(access ``json``, …)`) is not miscounted — the Python walks AST
  // nodes, so string/comment text never appears as a structural or call node.
  // String literals are replaced by an operand sentinel `0`, so a real call's
  // callee/method name (where every serialization/observability marker lives)
  // survives intact (`json.dumps(0)`), while string ARGUMENTS cannot manufacture
  // a marker hit or a phantom call.
  const maskedBody = maskStringsAndComments(scanBody);

  // --- nSerializationCalls + observability calls + n_calls -------------------
  // Walk each call site once; mirror the Python per-call marker matching.
  let nSerializationCalls = 0;
  let nObservCalls = 0;
  let nCalls = 0;
  if (!goTypeDecl) {
    for (const site of enumerateCallSites(maskedBody, scanBody)) {
      nCalls += 1;
      if (markerHit(site.headText, SERIALIZATION_MARKERS)) nSerializationCalls += 1;
      if (markerHit(site.headText, OBSERV_MARKERS)) nObservCalls += 1;
    }
  }

  // --- positive domain signals ----------------------------------------------
  const nDomainConditionals = goTypeDecl ? 0 : countDomainConditionals(maskedBody, lang);
  const nArithmeticOps = goTypeDecl ? 0 : countArithmeticOps(maskedBody);
  const nDomainExceptions = goTypeDecl ? 0 : countDomainExceptions(maskedBody, lang);
  const { assignStmts, attrToAttr, nStateTransitions } = goTypeDecl
    ? { assignStmts: 0, attrToAttr: 0, nStateTransitions: 0 }
    : scanAssignments(scanBody, lang);
  const nDomainSignals =
    nDomainConditionals + nArithmeticOps + nDomainExceptions + nStateTransitions;

  // --- getter/setter + dto_mapper_ratio (Python lines 718-722, 724-729) ------
  // `loc` = endLine - startLine + 1. The business-logic phase slices the body
  // as `lines.slice(startLine-1, endLine).join("\n")` — no trailing newline —
  // so the body's physical line count equals `loc`. A trailing empty line (test
  // snippets end with "\n") is dropped so `loc` matches the Python node span.
  const loc = bodyLineCount(bodyText);
  const nReturns = goTypeDecl ? 0 : countReturns(scanBody);
  const nTotalConditionals = goTypeDecl ? 0 : countTotalConditionals(maskedBody, lang);

  // dto_mapper_ratio = round(attr_to_attr / assign_stmts, 3) when assign_stmts>0.
  const dtoMapperRatio = assignStmts > 0 ? round3(attrToAttr / assignStmts) : 0.0;

  // is_getter_setter (Python operator precedence: A and B and (C or (D and E))):
  //   loc<=4 AND n_total_conditionals==0 AND
  //   (name startswith get/set/is/has OR (n_returns<=1 AND n_calls==0))
  // then the inner `if loc<=3` actually sets it — so loc<=3 is the binding bound.
  const lowName = symbolName.toLowerCase();
  let isGetterSetter = false;
  if (
    loc <= 4 &&
    nTotalConditionals === 0 &&
    (lowName.startsWith("get") ||
      lowName.startsWith("set") ||
      lowName.startsWith("is") ||
      lowName.startsWith("has") ||
      (nReturns <= 1 && nCalls === 0))
  ) {
    if (loc <= 3) isGetterSetter = true;
  }

  // --- ORM-model class-head detection ---------------------------------------
  let isOrmModel = false;
  if (isClass) {
    const head = classHeadText ?? "";
    const { className, baseIdents, annotBlob } = classNameAndBases(head, lang);
    isOrmModel = classHeadIsOrmModel(className, baseIdents, annotBlob);
  }

  // --- negative plumbing signals (EXACT Python n_plumbing_signals) -----------
  // och_bizlogic_extract.py lines 767-769:
  //   n_plumbing_signals = n_serialization_calls + n_observ_calls
  //                        + (1 if is_getter_setter else 0)
  //                        + (1 if dto_mapper_ratio >= 0.5 else 0)
  // Qualified-persistence / raw-SQL / bootstrap are NOT part of this field — they
  // feed touches_persistence / is_framework_bootstrap, which the kernel ignores.
  const nPlumbingSignals =
    nSerializationCalls + nObservCalls + (isGetterSetter ? 1 : 0) + (dtoMapperRatio >= 0.5 ? 1 : 0);

  return { nSerializationCalls, nDomainSignals, nPlumbingSignals, isOrmModel };
}

/** Round to 3 decimals (Python `round(x, 3)`, half-to-even-tolerant for our use). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Physical line count of a sliced body, equal to the Python `loc`
 * (`endLine - startLine + 1`). The business-logic phase produces the body via
 * `lines.slice(startLine-1, endLine).join("\n")`, which has NO trailing newline,
 * so its line count already equals `loc`. Test/standalone snippets often end in
 * a trailing "\n"; we drop a single trailing empty segment so `loc` still
 * matches the Python AST node span (which ends on the last non-empty line).
 */
function bodyLineCount(bodyText: string): number {
  if (bodyText.length === 0) return 0;
  const parts = bodyText.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}
