import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parsePorcelainBlame } from "./git-blame-batcher.js";

describe("parsePorcelainBlame", () => {
  it("returns empty on empty input", () => {
    assert.deepEqual(parsePorcelainBlame(""), []);
  });

  it("parses a two-commit, three-line blame", () => {
    // Two groups: the first spans line 1 (group-size 1), the second spans
    // lines 2-3. Only the first line of each group carries the author
    // headers; the second line of group two reuses the cached metadata.
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1",
      "author Alice",
      "author-mail <alice@example.com>",
      "\tcode line 1",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 2 2",
      "author Bob",
      "author-mail <bob@example.com>",
      "\tcode line 2",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 3",
      "\tcode line 3",
      "",
    ].join("\n");
    const lines = parsePorcelainBlame(stdout);
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((l) => ({
        line: l.line,
        email: l.email,
        sha: l.sha.slice(0, 4),
      })),
      [
        { line: 1, email: "alice@example.com", sha: "aaaa" },
        { line: 2, email: "bob@example.com", sha: "bbbb" },
        { line: 3, email: "bob@example.com", sha: "bbbb" },
      ],
    );
  });

  it("lowercases the email", () => {
    const stdout = [
      "abcdef0abcdef0abcdef0abcdef0abcdef0abcd 1 1 1",
      "author Alice",
      "author-mail <Alice@Example.COM>",
      "\tline",
      "",
    ].join("\n");
    const lines = parsePorcelainBlame(stdout);
    assert.equal(lines[0]?.email, "alice@example.com");
  });
});
