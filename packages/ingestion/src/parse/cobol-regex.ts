/**
 * COBOL regex hot path.
 *
 * Pure-function extractor for fixed-format COBOL files (`.cbl`, `.cob`,
 * `.cpy`). Emits {@link CobolElement} records for the five targets that a
 * human reader would use to navigate a legacy mainframe program:
 *
 *   - `program-id`   — `PROGRAM-ID. <name>.`, one per file
 *   - `paragraph`    — labels in Area A: `^[ ]{7}[A-Z0-9][A-Z0-9-]*\.`
 *   - `perform`      — `PERFORM <identifier>`, each occurrence (heuristic
 *                      CALL-like reference; the enclosing paragraph is the
 *                      caller)
 *   - `copy`         — `COPY <name>`, each occurrence (copybook inclusion)
 *   - `cics`         — `EXEC CICS ... END-EXEC` spans (multi-line aware)
 *
 * ## Fixed-format COBOL refresher
 *
 *   Columns 1-6   sequence numbers (ignored)
 *   Column  7     indicator area: `*` or `/` = comment line, `-` =
 *                 continuation, `D` = debugging aid, ` ` = normal
 *   Columns 8-11  Area A: divisions, sections, paragraphs
 *   Columns 12-72 Area B: statements
 *   Columns 73-80 identification (ignored)
 *
 * The default parse path runs at ≤ 1 ms on 1000-line fixtures; a p50
 * regression in that number is a graph-ingestion regression.
 *
 * ## Anti-goals
 *
 *   - NOT a full parse: `PERFORM ... THRU ... VARYING`, `COPY ... REPLACING
 *     ==tag== BY ==value==`, and nested `EXEC SQL` blocks are all resolved
 *     heuristically. The deep-parse path (ProLeap, when wired in) owns the
 *     precise AST.
 *   - NOT free-format aware: the 99% legacy estate is fixed-format;
 *     free-format COBOL (column-0 start) lands with the ProLeap backend.
 *   - NO filesystem I/O, NO subprocesses, NO external deps. The function
 *     is pure over `(path, content)`.
 *
 * ## Author's note
 *
 * The regex vocabulary here (PROGRAM-ID, PARAGRAPH, PERFORM, COPY, CICS) is
 * explicitly allow-listed in `scripts/check-banned-strings.sh` (U2 in spec
 * 004) because it's the standard public COBOL surface.
 */

import type { LanguageId } from "./types.js";

/** Tag for the kind of construct a {@link CobolElement} describes. */
export type CobolElementKind = "program-id" | "paragraph" | "perform" | "copy" | "cics";

/**
 * One element extracted from a COBOL file. The pipeline maps these to
 * `CodeElement` graph nodes downstream (see `pipeline/phases/parse.ts`).
 *
 * Line numbers are 1-indexed. `endLine` equals `startLine` for the
 * single-line PROGRAM-ID, paragraph, PERFORM, and COPY markers; CICS
 * spans cover the `EXEC CICS` → `END-EXEC` range.
 */
export interface CobolElement {
  readonly kind: CobolElementKind;
  /** Program name, paragraph label, target identifier, or copybook name. */
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: LanguageId;
  /** Regex extraction is not a parse; the confidence tier says so. */
  readonly confidence: "heuristic";
  /**
   * Optional human-readable snippet — the matched line (or first line of a
   * multi-line CICS block), whitespace-trimmed. Kept short so graph-node
   * payloads stay deterministic and compact.
   */
  readonly snippet?: string;
}

export interface CobolRegexResult {
  readonly elements: readonly CobolElement[];
  /** Every `COPY <name>` target referenced by this file, deduped + sorted. */
  readonly copybookRefs: readonly string[];
  /** Non-fatal notes (e.g. malformed CICS block). Empty on happy path. */
  readonly diagnostics: readonly string[];
}

// ---------------------------------------------------------------------------
// Regexes (all case-insensitive; the `/i` flag is set at the source below).
// ---------------------------------------------------------------------------

/**
 * PROGRAM-ID. <name>.  May have spaces around the period.
 * We intentionally match the full line rather than positional columns so a
 * mildly-misaligned fixture still classifies. A well-formed PROGRAM-ID sits
 * in Area A (column 8), and the matcher still works there too.
 */
const PROGRAM_ID_RE = /\bPROGRAM-ID\s*\.\s*([A-Z0-9][A-Z0-9-]*)/i;

/**
 * Paragraph label: 6 arbitrary chars (sequence area), a blank indicator
 * column, then a bare identifier plus a period at the start of Area A.
 * Legacy fixed-format lines often put digits in the sequence area
 * (`000100 MAIN-PARA.`), so we allow any character there rather than
 * insisting on 6 spaces. The matcher is applied only to non-comment
 * lines whose column 7 is blank — enforced via the explicit ` ` after
 * the `.{6}` anchor.
 */
const PARAGRAPH_RE = /^.{6} ([A-Z0-9][A-Z0-9-]*)\.\s*$/i;

/**
 * PERFORM <identifier>. We strip the `VARYING`, `UNTIL`, `TIMES`, `THRU`,
 * `THROUGH`, `WITH`, `TEST` keywords out of the set of valid target names
 * so they don't masquerade as paragraphs. Occurrence-based — one emission
 * per PERFORM, even if the same paragraph is called from multiple sites.
 */
const PERFORM_RE = /\bPERFORM\s+([A-Z0-9][A-Z0-9-]*)/gi;

/**
 * COPY <name> — both simple (`COPY BOOKFILE.`) and REPLACING variants
 * (the REPLACING clause is ignored here; deep parse handles it).
 */
const COPY_RE = /\bCOPY\s+([A-Z0-9][A-Z0-9-]*)/gi;

/**
 * `EXEC CICS` opener — the closing `END-EXEC` is matched separately so we
 * can span multiple lines. A missing `END-EXEC` emits a diagnostic.
 */
const EXEC_CICS_OPEN_RE = /\bEXEC\s+CICS\b/i;
const END_EXEC_RE = /\bEND-EXEC\b/i;

/**
 * PERFORM modifiers that must NOT be reported as target paragraphs. COBOL
 * allows e.g. `PERFORM VARYING I FROM 1` or `PERFORM UNTIL DONE` where the
 * first token after PERFORM is a keyword, not a paragraph name.
 */
const PERFORM_KEYWORD_TARGETS: ReadonlySet<string> = new Set([
  "VARYING",
  "UNTIL",
  "TIMES",
  "THRU",
  "THROUGH",
  "WITH",
  "TEST",
]);

const MAX_SNIPPET_LENGTH = 120;
const MAX_FILE_BYTES_FOR_REGEX = 5 * 1024 * 1024; // 5 MB — matches parse-worker cap.

/**
 * Parse a COBOL file and return the extracted element set. Pure function;
 * safe to call from any thread / worker.
 */
export function parseCobolFile(path: string, content: string): CobolRegexResult {
  const diagnostics: string[] = [];

  // Binary / oversize early exit — cheaper than splitting into lines first.
  if (content.length === 0) {
    return { elements: [], copybookRefs: [], diagnostics: [] };
  }
  if (content.length > MAX_FILE_BYTES_FOR_REGEX) {
    return {
      elements: [],
      copybookRefs: [],
      diagnostics: [`cobol-regex: ${path} exceeds ${MAX_FILE_BYTES_FOR_REGEX}-byte cap; skipping`],
    };
  }
  if (looksBinary(content)) {
    return {
      elements: [],
      copybookRefs: [],
      diagnostics: [`cobol-regex: ${path} looks binary; skipping`],
    };
  }

  const lines = content.split(/\r?\n/);
  const elements: CobolElement[] = [];
  const copybookSet = new Set<string>();

  let programIdEmitted = false;
  let cicsOpenLine: number | undefined;
  let cicsOpenSnippet: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;

    // Comment lines: `*` or `/` in column 7 (0-indexed position 6). We also
    // honor `*>` at any column (the rare free-format-style inline comment).
    if (isCommentLine(raw)) continue;

    // Strip the sequence area (columns 1-6) and indicator (column 7) before
    // running pattern matches, so PROGRAM-ID / PERFORM / COPY matches in
    // Area A + B are indifferent to column bookkeeping. We KEEP the raw
    // line for the paragraph-label matcher, which cares about column
    // alignment.
    const stripped = stripSequenceAndIndicator(raw);

    // --- PROGRAM-ID ---
    // Only the first PROGRAM-ID counts (per the COBOL spec there is exactly
    // one per file). We still warn on extras as a diagnostic.
    if (!programIdEmitted) {
      const m = stripped.match(PROGRAM_ID_RE);
      if (m !== null && m[1] !== undefined) {
        elements.push({
          kind: "program-id",
          name: m[1],
          filePath: path,
          startLine: lineNo,
          endLine: lineNo,
          language: "cobol",
          confidence: "heuristic",
          snippet: trimSnippet(raw),
        });
        programIdEmitted = true;
      }
    } else if (PROGRAM_ID_RE.test(stripped)) {
      diagnostics.push(`cobol-regex: ${path}:${lineNo}: duplicate PROGRAM-ID ignored`);
    }

    // --- Paragraph label (strict column-alignment matcher on the raw line) ---
    const paraMatch = raw.match(PARAGRAPH_RE);
    if (paraMatch !== null && paraMatch[1] !== undefined) {
      // Skip reserved division / section headers — they also match the
      // grammar but live in their own COBOL level. The usual suspects are
      // "IDENTIFICATION", "ENVIRONMENT", "DATA", "PROCEDURE", "WORKING-STORAGE",
      // "LINKAGE", "FILE", "LOCAL-STORAGE" — see ISO/IEC 1989:2014 §8.
      if (!isReservedDivisionOrSection(paraMatch[1])) {
        elements.push({
          kind: "paragraph",
          name: paraMatch[1],
          filePath: path,
          startLine: lineNo,
          endLine: lineNo,
          language: "cobol",
          confidence: "heuristic",
          snippet: trimSnippet(raw),
        });
      }
    }

    // --- PERFORM target(s) on this line ---
    // Reset regex state per line because of the `g` flag.
    PERFORM_RE.lastIndex = 0;
    for (let m = PERFORM_RE.exec(stripped); m !== null; m = PERFORM_RE.exec(stripped)) {
      const target = m[1];
      if (target === undefined) continue;
      if (PERFORM_KEYWORD_TARGETS.has(target.toUpperCase())) continue;
      elements.push({
        kind: "perform",
        name: target,
        filePath: path,
        startLine: lineNo,
        endLine: lineNo,
        language: "cobol",
        confidence: "heuristic",
        snippet: trimSnippet(raw),
      });
    }

    // --- COPY target(s) on this line ---
    COPY_RE.lastIndex = 0;
    for (let m = COPY_RE.exec(stripped); m !== null; m = COPY_RE.exec(stripped)) {
      const target = m[1];
      if (target === undefined) continue;
      copybookSet.add(target);
      elements.push({
        kind: "copy",
        name: target,
        filePath: path,
        startLine: lineNo,
        endLine: lineNo,
        language: "cobol",
        confidence: "heuristic",
        snippet: trimSnippet(raw),
      });
    }

    // --- EXEC CICS ... END-EXEC spans ---
    // State machine: when we hit EXEC CICS (without an inline END-EXEC on
    // the same line), remember the opening line and look for END-EXEC on
    // subsequent lines. If the closing token shows up on the same line
    // (single-line inline block), emit immediately.
    if (cicsOpenLine === undefined) {
      if (EXEC_CICS_OPEN_RE.test(stripped)) {
        if (END_EXEC_RE.test(stripped)) {
          elements.push({
            kind: "cics",
            name: inferCicsVerb(stripped),
            filePath: path,
            startLine: lineNo,
            endLine: lineNo,
            language: "cobol",
            confidence: "heuristic",
            snippet: trimSnippet(raw),
          });
        } else {
          cicsOpenLine = lineNo;
          cicsOpenSnippet = trimSnippet(raw);
        }
      }
    } else {
      if (END_EXEC_RE.test(stripped)) {
        elements.push({
          kind: "cics",
          name: cicsOpenSnippet !== undefined ? inferCicsVerb(cicsOpenSnippet) : "CICS",
          filePath: path,
          startLine: cicsOpenLine,
          endLine: lineNo,
          language: "cobol",
          confidence: "heuristic",
          ...(cicsOpenSnippet !== undefined ? { snippet: cicsOpenSnippet } : {}),
        });
        cicsOpenLine = undefined;
        cicsOpenSnippet = undefined;
      }
    }
  }

  // Dangling EXEC CICS block — record a diagnostic but emit nothing.
  if (cicsOpenLine !== undefined) {
    diagnostics.push(`cobol-regex: ${path}:${cicsOpenLine}: EXEC CICS without matching END-EXEC`);
  }

  const copybookRefs = [...copybookSet].sort();

  return { elements, copybookRefs, diagnostics };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `true` if the line is a COBOL comment (col 7 = `*` or `/`) OR if it's
 * whitespace-only (cheaper to skip than to match).
 */
function isCommentLine(raw: string): boolean {
  if (raw.length === 0) return true;
  if (/^\s*$/.test(raw)) return true;
  // Column 7 (0-indexed 6) — guard length before peeking.
  const indicator = raw.length >= 7 ? raw.charAt(6) : "";
  if (indicator === "*" || indicator === "/") return true;
  // Rare inline marker used by some dialects; cheap extra check.
  if (raw.trimStart().startsWith("*>")) return true;
  return false;
}

/**
 * Strip columns 1-7 (sequence + indicator areas) from a fixed-format line.
 * Shorter lines return empty — caller handles that gracefully.
 */
function stripSequenceAndIndicator(raw: string): string {
  if (raw.length <= 7) return "";
  return raw.slice(7);
}

/**
 * COBOL reserved division + section headers that would otherwise trip the
 * paragraph matcher. Upper-case set for O(1) lookup; caller uppercases.
 */
const RESERVED_AREA_A: ReadonlySet<string> = new Set([
  "IDENTIFICATION",
  "ENVIRONMENT",
  "DATA",
  "PROCEDURE",
  "WORKING-STORAGE",
  "LINKAGE",
  "FILE",
  "LOCAL-STORAGE",
  "CONFIGURATION",
  "INPUT-OUTPUT",
  "FILE-CONTROL",
  "SPECIAL-NAMES",
  "REPORT",
  "SCREEN",
  "COMMUNICATION",
]);

function isReservedDivisionOrSection(name: string): boolean {
  return RESERVED_AREA_A.has(name.toUpperCase());
}

/**
 * Heuristic — pull the first CICS verb (`READ`, `WRITE`, `LINK`, `XCTL`,
 * `RETURN`, `SEND`, `RECEIVE`, etc.) out of the `EXEC CICS` opener so the
 * graph node carries a human-readable name rather than a bare `"CICS"`.
 */
function inferCicsVerb(stripped: string): string {
  const m = stripped.match(/\bEXEC\s+CICS\s+([A-Z][A-Z0-9-]*)/i);
  if (m === null || m[1] === undefined) return "CICS";
  return `CICS ${m[1].toUpperCase()}`;
}

/**
 * Peek the first ~2 KB for NUL bytes — matches the scan-phase binary
 * heuristic. Cheaper than the 8 KB probe the scan phase uses, but fine
 * here since the scan phase already filtered obvious binaries upstream.
 */
function looksBinary(content: string): boolean {
  const probeLen = Math.min(content.length, 2048);
  for (let i = 0; i < probeLen; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

function trimSnippet(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
}
