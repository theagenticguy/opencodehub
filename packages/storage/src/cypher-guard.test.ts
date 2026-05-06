import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReadOnlyCypher, CypherGuardError } from "./cypher-guard.js";

function reject(cypher: string, label: string): void {
  assert.throws(
    () => {
      assertReadOnlyCypher(cypher);
    },
    CypherGuardError,
    `expected rejection: ${label}`,
  );
}

function accept(cypher: string, label: string): void {
  assert.doesNotThrow(() => {
    assertReadOnlyCypher(cypher);
  }, `expected acceptance: ${label}`);
}

test("accepts every reader leading keyword", () => {
  accept("MATCH (n) RETURN n", "bare MATCH");
  accept("MATCH (n:CodeNode) WHERE n.id = '1' RETURN n.name", "MATCH with WHERE");
  accept("MATCH (n) RETURN n ORDER BY n.id LIMIT 10", "ORDER BY + LIMIT");
  accept("MATCH (n) RETURN n SKIP 5 LIMIT 10", "SKIP + LIMIT");
  accept("OPTIONAL MATCH (n)-[r]->(m) RETURN r", "OPTIONAL MATCH");
  accept("WITH 1 AS one RETURN one", "bare WITH");
  accept("UNWIND [1,2,3] AS x RETURN x", "bare UNWIND");
  accept("RETURN 1 AS one", "bare RETURN");
});

test("accepts whitespace and comment mixes", () => {
  accept("  \n  MATCH (n) RETURN n  \n", "leading/trailing whitespace");
  accept("// a line comment\nMATCH (n) RETURN n", "line comment before");
  accept("MATCH (n) // inline comment\nRETURN n", "inline comment");
  accept("/* block comment */ MATCH (n) RETURN n", "leading block comment");
  accept("MATCH (n) /* mid */ RETURN n", "mid block comment");
  accept(
    "// CREATE this later\nMATCH (n) RETURN n",
    "banned verb inside line comment must be stripped",
  );
  accept(
    "/* DELETE me eventually */ MATCH (n) RETURN n",
    "banned verb inside block comment must be stripped",
  );
});

test("rejects every write verb as leading keyword", () => {
  reject("CREATE (n:Foo) RETURN n", "leading CREATE");
  reject("DELETE n", "leading DELETE");
  reject("SET n.x = 1", "leading SET");
  reject("MERGE (n:Foo {id: 1})", "leading MERGE");
  reject("REMOVE n.prop", "leading REMOVE");
  reject("DROP TABLE CodeNode", "leading DROP");
});

test("rejects write verbs hidden after a legitimate MATCH", () => {
  reject("MATCH (n) CREATE (m:Foo) RETURN m", "MATCH ... CREATE");
  reject("MATCH (n) DELETE n", "MATCH ... DELETE");
  reject("MATCH (n) SET n.x = 1", "MATCH ... SET");
  reject("MATCH (n) MERGE (m:Foo)", "MATCH ... MERGE");
  reject("MATCH (n) REMOVE n.prop", "MATCH ... REMOVE");
  reject("MATCH (n) DETACH DELETE n", "MATCH ... DETACH DELETE");
});

test("rejects write verbs hidden in the middle of the query", () => {
  reject("MATCH (n)\nWHERE n.kind = 'Function'\nSET n.x = 1\nRETURN n", "multi-line SET");
  reject("MATCH (n)\nWITH n\nDELETE n", "WITH then DELETE");
});

test("CALL: rejects unknown procedures", () => {
  reject("CALL db.schema.nodeTypeProperties()", "administrative proc");
  reject("CALL CREATE_FTS_INDEX('CodeNode', 'idx', ['name'])", "index creation");
  reject("CALL SHOW_TABLES()", "show tables");
  reject("CALL my_user_defined()", "user-defined");
  reject("CALL", "bare CALL no procedure");
});

test("CALL: accepts the two allow-listed read-only procedures", () => {
  accept("CALL QUERY_FTS_INDEX('CodeNode', 'och_fts', 'hello') RETURN node, score", "FTS read");
  accept(
    "CALL QUERY_FTS_INDEX('CodeNode', 'och_fts', 'hello') WITH node, score RETURN node LIMIT 10",
    "FTS with WITH + LIMIT",
  );
  accept(
    "CALL QUERY_VECTOR_INDEX('Embedding', 'och_vec', [0.1, 0.2, 0.3], 10) RETURN node",
    "vector read",
  );
  // Case insensitivity — the procedure names are uppercase in the allowlist
  // but the user might write them lowercase.
  accept(
    "call query_fts_index('CodeNode', 'och_fts', 'hello') return node",
    "lowercase CALL + procedure",
  );
});

test("CALL: rejects write verbs appearing after an allow-listed procedure", () => {
  reject(
    "CALL QUERY_FTS_INDEX('CodeNode', 'och_fts', 'x') WITH node DELETE node",
    "FTS ... DELETE",
  );
  reject(
    "CALL QUERY_VECTOR_INDEX('Embedding', 'och_vec', [0.1], 10) WITH node SET node.x = 1",
    "vector ... SET",
  );
});

test("rejects empty / whitespace-only / comment-only inputs", () => {
  reject("", "empty string");
  reject("   \n\t  ", "whitespace only");
  reject("// comment only", "line comment only");
  reject("/* comment only */", "block comment only");
});

test("rejects OPTIONAL not followed by MATCH", () => {
  reject("OPTIONAL RETURN 1", "OPTIONAL RETURN");
  reject("OPTIONAL", "bare OPTIONAL");
});

test("rejects LOAD EXTENSION", () => {
  reject("LOAD EXTENSION fts", "LOAD EXTENSION leading");
  reject("MATCH (n) RETURN n; LOAD EXTENSION fts", "LOAD EXTENSION after reader");
});

test("allows banned words that appear only as column / property names", () => {
  // `created_at`, `createdAt`, `setter` are common property names; the
  // word-boundary regex must not match any of these.
  accept("MATCH (n) RETURN n.created_at", "created_at column");
  accept("MATCH (n) RETURN n.createdAt", "createdAt camelCase property");
  accept("MATCH (n) WHERE n.createdAt > 0 RETURN n.setter", "setter-like property");
  accept("MATCH (n) RETURN n.resetAt", "resetAt ends in 'set' lookalike");
  accept("MATCH (n) RETURN n.imported AS imp", "imported as alias");
});

test("tolerates banned keywords inside string literals", () => {
  // The stripper removes string bodies before the keyword sweep, so a
  // legitimate property literal that contains a write verb is accepted.
  accept("MATCH (n) WHERE n.note = 'please DELETE this later' RETURN n", "DELETE in string");
  accept('MATCH (n) WHERE n.note = "SET this x = 1" RETURN n', "SET in double-quoted string");
  accept("MATCH (n) WHERE n.name = 'CREATE' RETURN n", "bare CREATE as string");
  accept(
    "MATCH (n) WHERE n.sql = 'DROP TABLE users' AND n.kind = 'Doc' RETURN n",
    "multi-write string contains DROP",
  );
});

test("comment-stripping: '//' inside a string literal is NOT a comment (primary case)", () => {
  // Primary edge case: a URL-like value inside a string should not be
  // treated as a line comment.
  accept(
    "MATCH (n) WHERE n.url = 'https://example.com/path' RETURN n.url",
    "URL with // inside single-quoted string",
  );
  accept(
    'MATCH (n) WHERE n.url = "https://example.com" RETURN n',
    "URL with // inside double-quoted string",
  );
  // Without the string-aware stripping, the rest-of-line comment stripper
  // would eat the `'` terminator and leave the query looking empty / malformed.
  // The assertion here is simply that the guard accepts the statement —
  // proof that the stripper did NOT treat the URL's `//` as a comment.
});

test("comment-stripping limitation: backslash-escaped quote is honored", () => {
  // TODO: the current stripper recognises `'` and `"` with backslash
  // escaping. Cypher's native string grammar does not actually require
  // backslash escaping for quotes (it uses doubled `''` for escaping in
  // some dialects); this shim covers the pragmatic case. Document the
  // limitation with an explicit test that backslash-escape works.
  accept(
    "MATCH (n) WHERE n.note = 'it\\'s fine' RETURN n",
    "backslash-escaped apostrophe inside single-quoted string",
  );
});

test("accepts a realistic traversal that uses every allowed clause", () => {
  const cypher = [
    "// top-level comment",
    "MATCH p = (start:CodeNode {id: 'x'})-[r:IMPORTS*1..3]->(other:CodeNode)",
    "WHERE ALL(rel IN rels(p) WHERE rel.confidence >= 0.5)",
    "WITH p, other",
    "UNWIND nodes(p) AS step",
    "RETURN other.id AS node_id, length(p) AS depth",
    "ORDER BY depth, node_id",
    "SKIP 0 LIMIT 50",
  ].join("\n");
  accept(cypher, "realistic traversal");
});
