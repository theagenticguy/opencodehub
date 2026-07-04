/**
 * Provider extractor characterization ("golden") harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * The per-language provider tests (`swift.test.ts`, `csharp.test.ts`, …) are
 * STRUCTURAL: they assert set-membership ("defs include `Greeter`"), so they do
 * NOT lock hash-relevant VALUES like `calleeOwner`, `qualifiedName`, `startLine`,
 * or `owner`. A refactor that collapses the per-provider `extractCalls` /
 * `extractHeritage` implementations into shared generics could silently drift one
 * of those fields and still pass every existing test — but change the downstream
 * `graphHash`.
 *
 * This harness closes that gap. For all 16 registered providers × the 4 core
 * extractors, it snapshots the FULL canonical-JSON output over a representative
 * fixture and asserts byte-equality against a committed golden
 * (`characterization-golden.ts`). It fails loudly with a per-language, per-extractor
 * diff on any value drift.
 *
 * DESIGN
 * ------
 *  - Fixtures reuse the exact `FIXTURE` string each per-language `*.test.ts` defines
 *    (representative; known to exercise defs/calls/heritage/imports). cobol has no
 *    tree-sitter grammar, so it is NOT routed through the ParsePool — its provider
 *    ignores inputs and returns [] for every extractor; we snapshot the empty arrays.
 *  - Each extractor output array is sorted by `canonicalJson(element)` before
 *    snapshotting. That is a stable TOTAL order, so a pure emission-order refactor
 *    does NOT false-positive, while any VALUE drift changes an element's canonical
 *    string and IS caught.
 *  - Coverage is a tripwire: the harness asserts it snapshotted exactly
 *    `listProviders().length` languages, so adding a provider forces a golden update.
 *
 * REGENERATING THE GOLDEN (deliberate, reviewed behavior changes ONLY)
 * --------------------------------------------------------------------
 *   UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion build
 *   UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion test
 * The env flag rewrites `src/providers/characterization-golden.ts` from the live
 * extractor output, then STILL asserts against the just-written values. Without the
 * flag the golden is never mutated — the test is read-only.
 */

import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { canonicalJson, type LanguageId } from "@opencodehub/core-types";
import { ParsePool } from "../parse/worker-pool.js";
import { type ExtractorSnapshot, GOLDEN } from "./characterization-golden.js";
import { getProvider, listProviders } from "./registry.js";
import { type ParsedFixture, parseFixture } from "./test-helpers.js";

/**
 * One representative fixture per language. The 15 tree-sitter languages reuse the
 * verbatim `FIXTURE` string from their existing behavior test (each already
 * exercises definitions + calls + heritage + imports). cobol gets a small program
 * whose captures are empty (no grammar), which its stub provider maps to [].
 */
const FIXTURES: Record<LanguageId, { readonly path: string; readonly source: string }> = {
  typescript: {
    path: "greeter.ts",
    source: `
import { Logger } from "./logger.js";
import * as util from "./util";
import defaultExport, { other } from "./mixed";

export interface Greeter extends Base {
  greet(name: string): string;
}

export abstract class Welcomer implements Greeter {
  private banner: string;
  public greet(name: string): string {
    this.log(name);
    return "hi " + name;
  }
  private log(msg: string): void {
    Logger.debug(msg);
  }
}

export const MESSAGE = "welcome";

export function run(): void {
  const w = new Welcomer();
  w.greet("world");
}
`,
  },
  tsx: {
    path: "page.tsx",
    source: `
import React from "react";
import { Button } from "./button.js";

interface Props {
  name: string;
}

export function Greeting(props: Props) {
  const label = svc.format(props.name);
  return <Button label={label} />;
}

export class Page extends React.Component<Props> {
  render() {
    return <Greeting name={this.props.name} />;
  }
}
`,
  },
  javascript: {
    path: "esm.js",
    source: `
import { Logger } from "./logger.js";
import defaultExport from "./default.js";

export class Base {
  hello() {
    return "hi";
  }
}

export class Greeter extends Base {
  greet(name) {
    this.hello();
    Logger.debug(name);
    return "hi " + name;
  }
}

export function run() {
  const g = new Greeter();
  g.greet("world");
}

function _internalHelper() {
  return 0;
}
`,
  },
  python: {
    path: "mod.py",
    source: `
import os
import numpy as np
from typing import List, Optional as Opt
from utils import *

MAX_RETRY = 3
_internal_version = "0.1"

class Base:
    def greet(self, name):
        return "hi " + name

class Greeter(Base, Mixin):
    def greet(self, name):
        os.getenv("USER")
        return super().greet(name)

    def _private(self):
        self.greet("world")

def run():
    g = Greeter()
    g.greet("world")
`,
  },
  go: {
    path: "greet.go",
    source: `package greet

import (
    "fmt"
    str "strings"
    . "errors"
)

type Greeter struct {
    name string
}

type Speaker interface {
    Speak() string
}

const (
    MaxGreet = 3
)

func (g *Greeter) Greet(msg string) string {
    return fmt.Sprintf("hi %s: %s", g.name, str.ToLower(msg))
}

func run() {
    g := &Greeter{name: "world"}
    g.Greet("hello")
}

func Exported() {}
func internal() {}
`,
  },
  rust: {
    path: "lib.rs",
    source: `
use std::collections::{HashMap, BTreeMap as Sorted};
use crate::logger::Logger;
use crate::util::*;
pub use self::public_api::*;

pub trait Greet {
    fn greet(&self, name: &str) -> String;
}

pub struct Greeter {
    pub name: String,
}

impl Greet for Greeter {
    fn greet(&self, name: &str) -> String {
        self.log(name);
        format!("hi {}", name)
    }
}

impl Greeter {
    fn log(&self, msg: &str) {
        Logger::debug(msg);
    }
}

pub const DEFAULT: u32 = 42;

fn internal() {}
pub fn run() {
    let g = Greeter { name: "world".to_string() };
    g.greet("hello");
}
`,
  },
  java: {
    path: "Welcomer.java",
    source: `
package com.example.greet;

import java.util.List;
import java.util.concurrent.*;
import static java.lang.Math.PI;

public interface Greeter {
    String greet(String name);
}

public abstract class Base {
    protected String prefix = "hi";
}

public class Welcomer extends Base implements Greeter, Runnable {
    private int count = 0;

    public Welcomer() {
        this.count = 1;
    }

    public String greet(String name) {
        return prefix + " " + name;
    }

    public void run() {
        greet("world");
        System.out.println(greet("world"));
    }
}

class Internal {}
`,
  },
  csharp: {
    path: "Welcomer.cs",
    source: `
using System;
using System.Collections.Generic;
using Json = Newtonsoft.Json;

namespace App.Greet
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public abstract class Base
    {
        protected string Prefix = "hi";
    }

    public class Welcomer : Base, IGreeter, IDisposable
    {
        private int _count;

        public Welcomer()
        {
            this._count = 1;
        }

        public string Greet(string name)
        {
            return Prefix + " " + name;
        }

        public void Dispose()
        {
            Console.WriteLine("done");
        }
    }

    public record Pair(string First, string Second);

    public struct Point { public int X; public int Y; }

    internal class Hidden {}
}
`,
  },
  c: {
    path: "user.c",
    source: `
#include <stdio.h>
#include "user.h"

typedef struct User {
    int id;
    char *name;
} User;

typedef enum Status {
    ACTIVE,
    INACTIVE
} Status;

static int _internal_counter = 0;

static void reset_counter(void) {
    _internal_counter = 0;
}

int register_user(const char *name) {
    User u;
    u.id = _internal_counter++;
    printf("registered %s\\n", name);
    return u.id;
}

int main(void) {
    register_user("alice");
    reset_counter();
    return 0;
}
`,
  },
  cpp: {
    path: "greet.cpp",
    source: `
#include <string>
#include "db.h"

namespace auth {

class Base {
public:
    virtual std::string hello() { return "hi"; }
};

class Mixin {
public:
    virtual void mix() {}
};

class Greeter : public Base, private Mixin {
public:
    Greeter(std::string name) : name_(name) {}
    std::string hello() { return "hello " + name_; }
private:
    std::string name_;
};

void run() {
    Greeter g("world");
    g.hello();
    Greeter *ptr = &g;
    ptr->hello();
    Base::hello();
}

static void _internalHelper() {}

}  // namespace auth
`,
  },
  ruby: {
    path: "auth.rb",
    source: `
require 'digest'
require_relative './session'

module Auth
  class Base
    def greet(name)
      "hi " + name
    end
  end

  module Logger
    def log(msg); end
  end

  class Greeter < Base
    include Logger

    def greet(name)
      log("greeting " + name)
      super
    end

    def _private
      greet("world")
    end
  end
end

def run
  g = Auth::Greeter.new
  g.greet("world")
end
`,
  },
  kotlin: {
    path: "Auth.kt",
    source: `
package auth

import java.util.UUID
import kotlin.collections.*

interface Logger {
    fun log(msg: String)
}

open class Base {
    open fun hello(): String = "hi"
}

class Greeter(val name: String) : Base(), Logger {
    override fun hello(): String {
        log("saying hi to " + name)
        return super.hello() + " " + name
    }

    override fun log(msg: String) {
        println(msg)
    }
}

fun run() {
    val g = Greeter("world")
    g.hello()
}

fun _privateHelper() {}
`,
  },
  swift: {
    path: "Auth.swift",
    source: `
import Foundation

protocol Logger {
    func log(_ msg: String)
}

class Base {
    func hello() -> String { return "hi" }
}

class Greeter: Base, Logger {
    let name: String

    init(name: String) {
        self.name = name
    }

    override func hello() -> String {
        log("saying hi")
        return super.hello() + " " + name
    }

    func log(_ msg: String) {
        print(msg)
    }
}

func run() {
    let g = Greeter(name: "world")
    _ = g.hello()
}

func _privateHelper() {}
`,
  },
  php: {
    path: "Auth.php",
    source: `<?php
namespace Auth;

use Psr\\Log\\LoggerInterface;
require_once 'config.php';

interface Authenticatable
{
    public function login(): bool;
}

trait Timestamps
{
    public function touch(): void {}
}

class Base
{
    public function hello(): string { return "hi"; }
}

class Greeter extends Base implements Authenticatable
{
    use Timestamps;

    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function login(): bool
    {
        $this->hello();
        Base::hello();
        return true;
    }
}

function run(): void
{
    $g = new Greeter("world");
    $g->login();
}
`,
  },
  dart: {
    path: "auth.dart",
    source: `
import 'dart:io';
import 'package:meta/meta.dart' as meta;

abstract class Logger {
  void log(String msg);
}

mixin Timestamps {
  void touch() {}
}

class Base {
  String hello() => "hi";
}

class Greeter extends Base with Timestamps implements Logger {
  final String name;

  Greeter(this.name);

  @override
  String hello() {
    log("saying hi");
    return super.hello() + " " + name;
  }

  @override
  void log(String msg) {
    stdout.writeln(msg);
  }
}

void run() {
  final g = Greeter("world");
  g.hello();
}

void _privateHelper() {}
`,
  },
  cobol: {
    path: "greet.cbl",
    source: `       IDENTIFICATION DIVISION.
       PROGRAM-ID. GREET.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-NAME PIC X(20) VALUE "WORLD".
       PROCEDURE DIVISION.
       MAIN-PARA.
           DISPLAY "HI " WS-NAME.
           STOP RUN.
`,
  },
};

/**
 * Stable TOTAL order over an extractor's output: sort by each element's own
 * canonical-JSON string. Reordering emission does not change the multiset, so
 * this cancels pure-reorder churn; any VALUE change alters an element's string
 * and therefore the sorted snapshot.
 */
function snapshot(records: readonly unknown[]): string {
  const sorted = [...records].sort((a, b) => {
    const ca = canonicalJson(a);
    const cb = canonicalJson(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  return canonicalJson(sorted);
}

/** Run all 4 core extractors for one provider over one parsed fixture. */
function snapshotProvider(langId: LanguageId, fx: ParsedFixture): ExtractorSnapshot {
  const provider = getProvider(langId);
  const definitions = provider.extractDefinitions({
    filePath: fx.filePath,
    captures: fx.captures,
    sourceText: fx.sourceText,
  });
  const calls = provider.extractCalls({
    filePath: fx.filePath,
    captures: fx.captures,
    definitions,
  });
  const heritage = provider.extractHeritage({
    filePath: fx.filePath,
    captures: fx.captures,
    definitions,
  });
  const imports = provider.extractImports({
    filePath: fx.filePath,
    sourceText: fx.sourceText,
  });
  return {
    definitions: snapshot(definitions),
    calls: snapshot(calls),
    heritage: snapshot(heritage),
    imports: snapshot(imports),
  };
}

/** Emit the regenerated golden module back to `src/` (regen flag only). */
function writeGolden(actual: Record<string, ExtractorSnapshot>): void {
  // Runs under `pnpm --filter @opencodehub/ingestion test`, whose cwd is the
  // package root — a stable anchor that avoids `import.meta.url` offset math.
  const target = resolve(process.cwd(), "src/providers/characterization-golden.ts");
  const header = `/**
 * GENERATED characterization golden — DO NOT hand-edit.
 *
 * This file is the committed, byte-stable snapshot consumed by
 * \`characterization.test.ts\`. It is a compiled-in \`const\` (not a JSON asset
 * read at runtime) so the test resolves it from \`dist\` with a plain import,
 * dodging \`import.meta.url\` path-offset fragility on bundle collapse.
 *
 * Each entry maps a \`LanguageId\` to the \`canonicalJson(...)\` string of that
 * language's SORTED extractor output (see the test for the sort key), one
 * string per core extractor. Full-value equality against these strings is the
 * safety net for the extractor-generic refactor: any drift in a hash-relevant
 * field (calleeOwner / qualifiedName / startLine / owner / …) changes the
 * canonical string and fails the test with a per-language, per-extractor diff.
 *
 * To regenerate (ONLY for a deliberate, reviewed behavior change):
 *   UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion build
 *   UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion test
 * The test rewrites THIS file's \`GOLDEN\` literal, then re-asserts against it.
 */

import type { LanguageId } from "@opencodehub/core-types";

/** Per-extractor canonical-JSON snapshots for one language. */
export interface ExtractorSnapshot {
  readonly definitions: string;
  readonly calls: string;
  readonly heritage: string;
  readonly imports: string;
}
`;
  const body = `\n// biome-ignore format: generated literal — leave the regenerator's formatting intact.\nexport const GOLDEN: Record<LanguageId, ExtractorSnapshot> = ${JSON.stringify(actual, null, 2)};\n`;
  writeFileSync(target, header + body, "utf8");
}

const REGEN = process.env["UPDATE_CHARACTERIZATION"] === "1";

describe("provider extractor characterization (all providers × 4 core extractors)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  /** langId → live snapshot for this run. */
  const actual: Record<string, ExtractorSnapshot> = {};
  /** Every registered language id, derived from the registry (never hardcoded). */
  const langIds: LanguageId[] = listProviders().map((p) => p.id);

  before(async () => {
    for (const langId of langIds) {
      const fixture = FIXTURES[langId];
      assert.ok(fixture, `no characterization fixture registered for language "${langId}"`);
      let fx: ParsedFixture;
      if (langId === "cobol") {
        // cobol has no tree-sitter grammar; the parse pool would not route it.
        // Its provider ignores inputs and returns [] for every extractor, so we
        // hand it an empty-capture fixture directly rather than routing it.
        fx = { filePath: fixture.path, sourceText: fixture.source, captures: [] };
      } else {
        fx = await parseFixture(pool, langId, fixture.path, fixture.source);
      }
      actual[langId] = snapshotProvider(langId, fx);
    }
    if (REGEN) {
      writeGolden(actual);
    }
  });

  it("covers exactly every registered provider (registry-count tripwire)", () => {
    // If a provider is added to the registry, this forces a deliberate golden
    // update rather than silently leaving the new language unsnapshotted.
    assert.equal(
      Object.keys(actual).length,
      listProviders().length,
      "characterization coverage drifted from the registry — add the new language's " +
        "fixture + golden (regen with UPDATE_CHARACTERIZATION=1)",
    );
    if (!REGEN) {
      assert.equal(
        Object.keys(GOLDEN).length,
        listProviders().length,
        "golden entry count drifted from the registry — regen with UPDATE_CHARACTERIZATION=1",
      );
    }
  });

  // One test per language × extractor: a drift produces a precise per-language,
  // per-extractor assertion failure (exactly which language and which extractor).
  for (const langId of listProviders().map((p) => p.id)) {
    describe(langId, () => {
      const extractors = ["definitions", "calls", "heritage", "imports"] as const;
      for (const extractor of extractors) {
        it(`${extractor} is byte-stable against the golden`, () => {
          const got = actual[langId];
          assert.ok(got, `no snapshot captured for "${langId}"`);
          const expected = GOLDEN[langId];
          assert.ok(
            expected,
            `no golden entry for "${langId}" — regen with UPDATE_CHARACTERIZATION=1`,
          );
          assert.equal(
            got[extractor],
            expected[extractor],
            `characterization drift: ${langId}.${extractor} changed value.\n` +
              "If this is a DELIBERATE behavior change, regen the golden:\n" +
              "  UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion build && \\\n" +
              "  UPDATE_CHARACTERIZATION=1 pnpm --filter @opencodehub/ingestion test",
          );
        });
      }
    });
  }
});
