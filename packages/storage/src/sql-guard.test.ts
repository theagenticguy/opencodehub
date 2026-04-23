import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReadOnlySql, SqlGuardError } from "./sql-guard.js";

function reject(sql: string, label: string): void {
  assert.throws(
    () => {
      assertReadOnlySql(sql);
    },
    SqlGuardError,
    `expected rejection: ${label}`,
  );
}

function accept(sql: string, label: string): void {
  assert.doesNotThrow(() => {
    assertReadOnlySql(sql);
  }, `expected acceptance: ${label}`);
}

test("rejects each banned leading keyword", () => {
  const banned = [
    "CREATE TABLE x (a INT)",
    "insert INTO nodes VALUES ('x')",
    "UPDATE nodes SET name='x'",
    "DELETE FROM nodes",
    "DROP TABLE nodes",
    "ALTER TABLE nodes ADD COLUMN c INT",
    "TRUNCATE nodes",
    "REPLACE INTO nodes VALUES ('x')",
    "ATTACH DATABASE '/etc/passwd' AS p",
    "COPY nodes TO '/tmp/out.csv'",
    "INSTALL fts",
    "LOAD fts",
    "PRAGMA create_fts_index('nodes','id','name')",
    "SET memory_limit='2GB'",
    "BEGIN TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "CALL some_procedure()",
    "USE main",
  ];
  for (const sql of banned) reject(sql, sql);
});

test("rejects stacked statements", () => {
  reject("SELECT 1; SELECT 2", "two selects");
  reject("SELECT 1; DROP TABLE nodes", "select + drop");
  reject("WITH x AS (SELECT 1) SELECT * FROM x; DELETE FROM nodes", "cte + delete");
});

test("permits trailing semicolon as a no-op", () => {
  accept("SELECT 1;", "trailing semi");
  accept("SELECT 1;   ", "trailing semi + spaces");
});

test("rejects banned verbs hidden inside a SELECT body", () => {
  reject("SELECT * FROM (SELECT 1) UNION ALL INSERT INTO nodes VALUES ('x')", "hidden insert");
  reject("WITH x AS (SELECT 1) DROP TABLE nodes", "hidden drop");
});

test("accepts valid read-only statements", () => {
  accept("SELECT 1", "bare SELECT");
  accept("SELECT id, name FROM nodes WHERE kind = 'Function' LIMIT 10", "filtered SELECT");
  accept("WITH t AS (SELECT 1) SELECT * FROM t", "CTE");
  accept(
    "WITH RECURSIVE walk(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM walk WHERE x < 5) SELECT * FROM walk",
    "recursive CTE",
  );
  accept("EXPLAIN SELECT 1", "EXPLAIN");
  accept("DESCRIBE nodes", "DESCRIBE");
  accept("SHOW TABLES", "SHOW");
  accept("SUMMARIZE nodes", "SUMMARIZE");
  accept("FROM nodes SELECT id", "FROM-first shorthand");
});

test("rejects empty / non-string inputs", () => {
  reject("", "empty");
  reject("   \n\t  ", "whitespace only");
  reject("-- just a comment", "comment only");
});

test("tolerates SQL-standard quoted strings containing banned keywords", () => {
  accept("SELECT 'DROP TABLE nodes' AS warning", "dangerous text inside string literal");
  accept('SELECT "CREATE" FROM nodes', "banned word as quoted identifier");
  accept("SELECT '' AS empty", "empty string literal");
  accept("SELECT 'it''s fine' AS doubled_quote", "doubled-quote escape inside string");
});

test("strips block and line comments before scanning", () => {
  accept("/* DROP TABLE nodes */ SELECT 1", "block comment banned word");
  accept("-- DROP TABLE nodes\nSELECT 1", "line comment banned word");
});
