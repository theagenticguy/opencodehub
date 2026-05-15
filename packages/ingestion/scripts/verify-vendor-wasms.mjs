#!/usr/bin/env node
// Pre-publish gate: assert vendor/wasms/ ships every WASM the runtime needs.
//
// Exits non-zero on any of:
//   - missing or empty .wasm file
//   - invalid WASM magic bytes (\0asm)
//   - manifest.json grammar version drift vs. packages/ingestion/package.json
//
// Run as `prepublishOnly` script in packages/ingestion/package.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const PKG_DIR = path.resolve(SCRIPT_DIR, "..");
const VENDOR_DIR = path.resolve(PKG_DIR, "vendor", "wasms");
const MANIFEST = path.resolve(VENDOR_DIR, "manifest.json");
const PJ = path.resolve(PKG_DIR, "package.json");

// 16 expected files: 15 grammar wasms + web-tree-sitter runtime wasm.
const EXPECTED = [
  "web-tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-c.wasm",
  "tree-sitter-cpp.wasm",
  "tree-sitter-ruby.wasm",
  "tree-sitter-php_only.wasm",
  "tree-sitter-kotlin.wasm",
  "tree-sitter-swift.wasm",
  "tree-sitter-dart.wasm",
];

// WASM binary magic: \0 a s m
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

const errors = [];

// 1. Every expected wasm exists, non-empty, has valid magic.
// Single open() per file avoids the existsSync→statSync→openSync TOCTOU
// pattern (CodeQL "potential filesystem race condition"); errno NOENT /
// short reads / bad magic each surface as one diagnostic.
for (const name of EXPECTED) {
  const p = path.resolve(VENDOR_DIR, name);
  let fd;
  try {
    fd = fs.openSync(p, "r");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      errors.push(`missing: ${name}`);
    } else {
      errors.push(`open failed: ${name} (${err && err.code ? err.code : err})`);
    }
    continue;
  }
  try {
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) {
      errors.push(`too small (${bytesRead} bytes): ${name}`);
    } else if (!buf.equals(WASM_MAGIC)) {
      errors.push(`invalid WASM magic in ${name}: got ${buf.toString("hex")}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// 2. manifest.json exists and matches package.json grammar pins.
// Read manifest with fs.readFileSync directly; failure surfaces as one error.
let manifestText;
try {
  manifestText = fs.readFileSync(MANIFEST, "utf8");
} catch (err) {
  if (err && err.code === "ENOENT") {
    errors.push(`missing manifest: ${MANIFEST}`);
  } else {
    errors.push(`manifest read failed: ${MANIFEST} (${err && err.code ? err.code : err})`);
  }
  manifestText = null;
}
if (manifestText !== null) {
  const manifest = JSON.parse(manifestText);
  const pj = JSON.parse(fs.readFileSync(PJ, "utf8"));
  const declared = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };

  if (manifest.schema !== "opencodehub.vendor-wasms.v1") {
    errors.push(`unexpected manifest schema: ${manifest.schema}`);
  }

  // The manifest is the source of truth for grammar versions. Native
  // tree-sitter and grammar packages are NOT workspace devDeps anymore —
  // they're installed on demand by scripts/build-vendor-wasms.sh during
  // re-vendoring. For each grammar, assert the manifest carries a version
  // string; if package.json happens to also declare it (during a vendor
  // run), the two must match.
  const checked = [
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-rust",
    "tree-sitter-java",
    "tree-sitter-c-sharp",
    "tree-sitter-c",
    "tree-sitter-cpp",
    "tree-sitter-ruby",
    "tree-sitter-php",
    "tree-sitter-kotlin",
    "tree-sitter-swift",
    "web-tree-sitter",
  ];
  for (const name of checked) {
    const manifestV = manifest.grammars?.[name];
    if (!manifestV) {
      errors.push(`${name}: missing from manifest.grammars`);
      continue;
    }
    const declaredV = declared[name]
      ? String(declared[name]).replace(/^[\^~=]/, "")
      : null;
    if (declaredV !== null && declaredV !== manifestV) {
      errors.push(
        `${name}: package.json pins ${declaredV} but manifest.json records ${manifestV} — re-run scripts/build-vendor-wasms.sh`,
      );
    }
  }

  // tree-sitter-dart never had a corresponding npm package; it's vendored
  // historically. Accept the marker.
  const dartV = manifest.grammars?.["tree-sitter-dart"];
  if (dartV !== "vendored-historically") {
    errors.push(
      `tree-sitter-dart: manifest expected "vendored-historically", got ${dartV ?? "(missing)"}`,
    );
  }
}

if (errors.length > 0) {
  console.error("verify-vendor-wasms.mjs FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  console.error(`Total: ${errors.length} error(s)`);
  process.exit(1);
}

console.log(`verify-vendor-wasms.mjs OK (${EXPECTED.length} wasm files, manifest matches package.json pins)`);
