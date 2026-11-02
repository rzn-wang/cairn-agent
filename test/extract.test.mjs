#!/usr/bin/env node
// Extraction + resolution tests for the knowledge graph. Standalone:
//   node test/extract.test.mjs   (or npm test)
// prints ok/FAIL per check and exits 1 on any failure. Also times extraction of
// a ~500 KB file and resolver construction + 100k resolves on 100k paths.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extract, langOf } from "../lib/graph/extract/index.mjs";
import { buildResolver, isTestPath, testTargets } from "../lib/graph/resolve.mjs";

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const imp = (r, spec) => r.imports.find((i) => i.spec === spec);
const sym = (r, name) => r.symbols.find((s) => s.name === name);
const specs = (r) => r.imports.map((i) => i.spec);
const names = (r) => r.symbols.map((s) => s.name);

// --- langOf ---------------------------------------------------------------
check("langOf", eq(
  ["a.tsx", "b.vue", "c.py", "d.go", "e.rs", "f.kt", "g.cs", "h.hpp", "i.rb", "j.php", "k.mdx", "l.txt", "Makefile"].map(langOf),
  ["js", "js", "python", "go", "rust", "jvm", "csharp", "cfamily", "ruby", "php", "markdown", null, null],
));

// --- js -------------------------------------------------------------------
{
  const r = extract(
    `import x from 'a';
import {a, b as c} from "b";
// import nope from 'nope'
/* import nope2 from 'nope2'
   import nope3 from 'nope3' */
import * as n from 'c';
import 'd';
import type {T} from 'e';
import {
  m1,
  m2 as z,
} from "f";
export {q} from 'g';
export * from 'h';
const r = require('i');
const p = import('j');
const s = "// not a comment"; import k from 'k';
export default async function foo() {}
export class Bar {}
export abstract class Baz {}
export const arrow = (x) => x;
let v = 2;
export interface I { a: string }
type U = string;
export enum E { A }
function local() {}
export function* gen() {}
export { local };
`,
    "src/a.ts",
  );
  check("js default import", eq(imp(r, "a"), { spec: "a", kind: "import", names: ["default"], line: 1 }), imp(r, "a"));
  check("js named import", eq(imp(r, "b").names, ["a", "b"]));
  check("js namespace import", eq(imp(r, "c").names, ["*"]));
  check("js side-effect import", imp(r, "d")?.kind === "import");
  check("js type import", eq(imp(r, "e").names, ["T"]));
  check("js multi-line import", eq(imp(r, "f"), { spec: "f", kind: "import", names: ["m1", "m2"], line: 9 }), imp(r, "f"));
  check("js reexport", imp(r, "g")?.kind === "reexport" && eq(imp(r, "g").names, ["q"]) && imp(r, "h")?.kind === "reexport");
  check("js require/dynamic", imp(r, "i")?.kind === "require" && imp(r, "j")?.kind === "dynamic");
  check("js comments stripped", !specs(r).some((s) => s.startsWith("nope")), specs(r));
  check("js comment marker in string kept", imp(r, "k")?.line === 17, imp(r, "k"));
  check("js symbols", ["foo", "Bar", "Baz", "arrow", "v", "I", "U", "E", "local", "gen"].every((n) => sym(r, n)), names(r));
  check("js kinds", sym(r, "foo").kind === "function" && sym(r, "Bar").kind === "class" && sym(r, "arrow").kind === "function" &&
    sym(r, "v").kind === "var" && sym(r, "I").kind === "interface" && sym(r, "U").kind === "type" && sym(r, "E").kind === "enum");
  check("js exported", sym(r, "foo").exported && sym(r, "Baz").exported && !sym(r, "v").exported && !sym(r, "U").exported);
  check("js export list marks local exported", sym(r, "local").exported);
  check("js hash shape", /^[0-9a-f]{12}$/.test(sym(r, "foo").hash) && /^[0-9a-f]{12}$/.test(sym(r, "foo").hash2));

  const a = extract("export function alpha(x) {\n  return alpha(x - 1) + 1;\n}\n", "a.js").symbols[0];
  const b = extract("export function beta(x) {\n  return beta(x - 1) + 1;\n}\n", "a.js").symbols[0];
  const c = extract("export function beta(x) {\n  return beta(x - 2) + 1;\n}\n", "a.js").symbols[0];
  check("hash2 equal for rename", a.hash !== b.hash && a.hash2 === b.hash2);
  check("hash2 differs for body change", b.hash2 !== c.hash2);
  const ws1 = extract("function f() {\n  return 1;\n}\n", "a.js").symbols[0];
  const ws2 = extract("function f()   {\n\n    return 1;\n}\n", "a.js").symbols[0];
  check("hash ignores whitespace", ws1.hash === ws2.hash);

  const many = Array.from({ length: 100 }, (_, i) => `${i % 10 === 0 ? "export " : ""}function f${i}() {}`).join("\n");
  const capped = extract(many, "m.js", { maxSymbols: 20 }).symbols;
  check("cap keeps exported first", capped.length === 20 && capped.filter((s) => s.exported).length === 10 && capped.some((s) => s.name === "f90"));
  check("cap default 64", extract(many, "m.js").symbols.length === 64);

  const vue = extract(`<template><div>import x from 'nope'</div></template>\n<script setup lang="ts">\nimport Foo from './Foo.vue'\nconst a = 1\n</script>\n`, "c.vue");
  check("vue script only", eq(specs(vue), ["./Foo.vue"]) && imp(vue, "./Foo.vue").line === 3, vue.imports);
  check("never throws", eq(extract(null, "a.ts"), { imports: [], symbols: [], mentions: [] }) && eq(extract("x", "a.unknown").imports, []));
}

// --- python ---------------------------------------------------------------
{
  const r = extract(
    `"""Module docstring.
def not_a_symbol():
    pass
"""
import os.path
import a.b as c, d
from .x import a
from ..x.y import (aa,
    bb as cc)
from . import sib
# import commented
try:
    import ujson as json
except ImportError:
    pass

MAX_SIZE = 10
_private = 1

def top():
    def inner():
        pass

async def co():
    pass

class Thing:
    def method(self):
        pass

def _hidden():
    pass
`,
    "pkg/mod.py",
  );
  check("py imports", eq(specs(r), ["os.path", "a.b", "d", ".x", "..x.y", ".", "ujson"]), specs(r));
  check("py from names", eq(imp(r, ".x").names, ["a"]) && eq(imp(r, "..x.y").names, ["aa", "bb"]) && eq(imp(r, ".").names, ["sib"]));
  check("py symbols", eq(names(r), ["MAX_SIZE", "top", "co", "Thing", "_hidden"]), names(r));
  check("py kinds/exported", sym(r, "MAX_SIZE").kind === "const" && sym(r, "Thing").kind === "class" && !sym(r, "_hidden").exported && sym(r, "top").exported);
}

// --- go -------------------------------------------------------------------
{
  const r = extract(
    `package lib

import "fmt"
import str "strings"
import (
	"os"
	alias "fx/internal/x"
	// "commented/out"
)

const Max = 3
var count int
var (
	Exported = 1
	hidden   = 2
)
type Server struct {
	Name string
}
type Handler interface{}
type ID string
func New() *Server { return nil }
func (s *Server) Start() error { return nil }
func (s Server) stop() {}
`,
    "lib/a.go",
  );
  check("go package", eq(r.imports[0], { spec: "lib", kind: "package", names: [], line: 1 }));
  check("go imports", eq(specs(r).slice(1), ["fmt", "strings", "os", "fx/internal/x"]), specs(r));
  check("go block import line", imp(r, "fx/internal/x").line === 7, imp(r, "fx/internal/x"));
  check("go symbols", ["Max", "count", "Exported", "hidden", "Server", "Handler", "ID", "New", "Server.Start", "Server.stop"].every((n) => sym(r, n)) && !sym(r, "Name"), names(r));
  check("go kinds", sym(r, "Server").kind === "struct" && sym(r, "Handler").kind === "interface" && sym(r, "ID").kind === "type" && sym(r, "Server.Start").kind === "method");
  check("go exported", sym(r, "New").exported && !sym(r, "count").exported && sym(r, "Server.Start").exported && !sym(r, "Server.stop").exported);
}

// --- rust -----------------------------------------------------------------
{
  const r = extract(
    `use crate::a::b;
use super::x;
use foo::{a, b::c};
use std::io::*;
pub use self::inner::Thing as T;
mod util;
pub mod api;
mod inline { fn hidden() {} }
extern crate serde;
// use commented::out;

pub fn run<'a>(s: &'a str) -> &'a str { s }
pub(crate) async fn go() {}
struct Private;
pub enum Kind { A }
pub trait Doer {}
type Alias = u8;
pub const MAX: usize = 3;
static mut COUNT: u32 = 0;
impl Doer for Private {}
#[macro_export]
macro_rules! my_macro { () => {} }
`,
    "src/lib.rs",
  );
  check("rust use paths", eq(specs(r), ["crate::a::b", "super::x", "foo", "std::io", "self::inner::Thing", "util", "api", "serde"]), specs(r));
  check("rust use names", eq(imp(r, "foo").names, ["a", "c"]) && eq(imp(r, "crate::a::b").names, ["b"]) && eq(imp(r, "std::io").names, ["*"]));
  check("rust mod decl only", imp(r, "util").kind === "mod" && !imp(r, "inline"));
  check("rust symbols", eq(names(r), ["inline", "run", "go", "Private", "Kind", "Doer", "Alias", "MAX", "COUNT", "my_macro"]), names(r));
  check("rust kinds/exported", sym(r, "run").kind === "function" && sym(r, "run").exported && sym(r, "go").exported && !sym(r, "Private").exported &&
    sym(r, "COUNT").kind === "var" && sym(r, "my_macro").kind === "macro" && sym(r, "my_macro").exported && sym(r, "inline").kind === "module");
}

// --- jvm ------------------------------------------------------------------
{
  const java = extract(
    `package a.b;

import a.c.Other;
import static a.c.Util.helper;
import java.util.*;
// import x.y.Z;

public final class Foo {
    public void bar() {}
}
interface Baz {}
enum Color { RED }
record Point(int x, int y) {}
private class Hidden {}
`,
    "src/main/java/a/b/Foo.java",
  );
  check("java package", eq(java.imports[0], { spec: "a.b", kind: "package", names: [], line: 1 }));
  check("java imports", eq(imp(java, "a.c.Other").names, ["Other"]) && imp(java, "a.c.Util.helper").static && eq(imp(java, "java.util.*").names, ["*"]) && !imp(java, "x.y.Z"));
  check("java symbols", eq(names(java), ["Foo", "Baz", "Color", "Point", "Hidden"]) && sym(java, "Color").kind === "enum" && !sym(java, "Hidden").exported, names(java));
  const kt = extract(
    `package a.k

import a.b.Foo
import kotlinx.coroutines.*

data class User(val name: String)
sealed class Result
object Registry
fun topLevel() = 1
private fun hidden() {}
typealias Name = String
enum class Mode { A }
`,
    "Foo.kt",
  );
  check("kotlin imports", eq(imp(kt, "a.b.Foo").names, ["Foo"]) && eq(imp(kt, "kotlinx.coroutines.*").names, ["*"]));
  check("kotlin symbols", eq(names(kt), ["User", "Result", "Registry", "topLevel", "hidden", "Name", "Mode"]) && sym(kt, "Mode").kind === "enum" && sym(kt, "topLevel").kind === "function" && sym(kt, "Name").kind === "type", names(kt));
  const scala = extract(`package a.s\nimport a.b.{C, D}\nimport a.e._\ntrait Show\ncase class Box(x: Int)\nobject Main\n`, "Main.scala");
  check("scala imports", eq(imp(scala, "a.b").names, ["C", "D"]) && eq(imp(scala, "a.e.*").names, ["*"]), scala.imports);
  check("scala symbols", eq(names(scala), ["Show", "Box", "Main"]) && sym(scala, "Show").kind === "trait");
}

// --- csharp ---------------------------------------------------------------
{
  const r = extract(
    `global using System;
using System.Collections.Generic;
using static System.Math;
using Json = Newtonsoft.Json;
// using Commented.Out;

namespace App.Core
{
    public sealed partial class Service
    {
        private class Nested {}
    }
    internal interface IThing {}
    public enum Mode { A }
    public record Person(string Name);
    public delegate void Handler(int x);
    private struct Hidden {}
}
`,
    "Service.cs",
  );
  check("cs usings", eq(specs(r), ["System", "System.Collections.Generic", "System.Math", "Newtonsoft.Json", "App.Core"]), specs(r));
  check("cs namespace package", imp(r, "App.Core").kind === "package" && imp(r, "System.Math").static);
  check("cs symbols", eq(names(r), ["Service", "IThing", "Mode", "Person", "Handler", "Hidden"]), names(r));
  check("cs exported", sym(r, "Service").exported && !sym(r, "Hidden").exported && sym(r, "Person").kind === "class");
  const fs = extract(`namespace App.Data;\n\npublic class Repo {\n    public class Inner {}\n}\n`, "Repo.cs");
  check("cs file-scoped namespace", imp(fs, "App.Data")?.kind === "package" && eq(names(fs), ["Repo"]), names(fs));
}

// --- cfamily --------------------------------------------------------------
{
  const r = extract(
    `#ifndef FOO_H
#define FOO_H
#include "local/foo.h"
#include <stdio.h>
// #include "commented.h"
#define MAX_SIZE 10

typedef unsigned int uint;
typedef void (*callback)(int);
typedef struct {
  int a;
} Pair;
struct Node {
  int v;
};
struct Fwd;
class Widget : public Base {
};
namespace ns {
}
enum class Color { Red };

static int helper(int x)
{
  return x;
}

int main(int argc, char **argv) {
  if (argc) { helper(1); }
  return 0;
}

void Widget::draw() const {
}
#endif
`,
    "foo.cpp",
  );
  check("c includes", eq(r.imports.map((i) => [i.spec, i.names]), [["local/foo.h", []], ["stdio.h", ["system"]]]), r.imports);
  const want = ["MAX_SIZE", "uint", "callback", "Pair", "Node", "Widget", "ns", "Color", "helper", "main", "Widget::draw"];
  check("c symbols", want.every((n) => sym(r, n)) && !sym(r, "FOO_H") && !sym(r, "Fwd") && !sym(r, "if"), names(r));
  check("c kinds", sym(r, "MAX_SIZE").kind === "macro" && sym(r, "Pair").kind === "type" && sym(r, "ns").kind === "module" && sym(r, "main").kind === "function" && !sym(r, "helper").exported);
}

// --- ruby -----------------------------------------------------------------
{
  const r = extract(
    `require 'json'
require_relative "helpers/util"
load 'tasks.rb'
# require 'commented'
=begin
class NotReal
=end
DOC = <<~EOS
  class AlsoNotReal
EOS

module Outer
  class Inner
    def method; end
  end
end

class Top
end

def helper
end
`,
    "lib/a.rb",
  );
  check("ruby requires", eq(specs(r), ["json", "helpers/util", "tasks.rb"]) && imp(r, "helpers/util").relative, r.imports);
  check("ruby symbols", eq(names(r), ["Outer", "Inner", "Top", "helper"]), names(r));
}

// --- php ------------------------------------------------------------------
{
  const r = extract(
    `<?php
namespace App\\Http;

use App\\Models\\User;
use App\\Services\\{Mailer, Logger};
// use Commented\\Out;
# use Hash\\Comment;
require_once __DIR__ . '/bootstrap.php';
include 'config.php';

#[Attribute]
final class Controller {
    public function index() {}
}
interface Contract {}
trait Loggable {}
enum Status {}
function helper() {}
`,
    "src/Http/Controller.php",
  );
  check("php namespace", imp(r, "App\\Http")?.kind === "package");
  check("php use", eq(imp(r, "App\\Models\\User").names, ["User"]) && eq(imp(r, "App\\Services").names, ["Mailer", "Logger"]));
  check("php require", imp(r, "./bootstrap.php")?.kind === "require" && imp(r, "config.php")?.kind === "require" && !specs(r).some((s) => /Commented|Hash/.test(s)), specs(r));
  check("php symbols", eq(names(r), ["Controller", "Contract", "Loggable", "Status", "helper"]), names(r));
}

// --- markdown -------------------------------------------------------------
{
  const r = extract(
    `# Title

See [the guide](docs/guide.md) and [code](../src/a.ts#L10), [site](https://x.com/a.md), [anchor](#top).
<!-- [hidden](hidden.md) \`hiddenIdent\` -->
Call \`buildResolver()\` from \`scripts/cairn/lib/graph/resolve.mjs\`, see \`store.mjs\` and \`fileIndex\`, \`MyClass\`, \`snake_case_name\`.
Plain \`word\` is ignored. Bare path src/lib/thing.ts here.

\`\`\`js
import x from "./in/fence.js"; [fenced](fenced.md)
\`\`\`

[ref]: ./other/ref.md
`,
    "docs/README.md",
  );
  check("md links", eq(r.imports.map((i) => [i.spec, i.kind]), [["docs/guide.md", "link"], ["../src/a.ts", "link"], ["./other/ref.md", "link"]]), r.imports);
  const m = r.mentions.map((x) => `${x.kind}:${x.text}`);
  const wantM = ["ident:buildResolver", "path:scripts/cairn/lib/graph/resolve.mjs", "path:store.mjs", "ident:fileIndex", "ident:MyClass", "ident:snake_case_name", "path:src/lib/thing.ts"];
  check("md mentions", wantM.every((x) => m.includes(x)) && !m.some((x) => /word|hidden|fence/.test(x)), m);
  check("md mentions deduped", new Set(m).size === m.length);
}

// --- resolver fixture repo ------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "cairn-graph-"));
const fixture = {
  "tsconfig.base.json": `{
    // JSONC: comments and trailing commas
    "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], }, },
  }`,
  "tsconfig.json": `{ "extends": "./tsconfig.base.json", "include": ["src"] }`,
  "package.json": `{ "name": "fixture-root", "private": true, "workspaces": ["packages/*"] }`,
  "packages/ui/package.json": `{ "name": "@fx/ui", "main": "src/index.ts" }`,
  "packages/ui/src/index.ts": `export const Button = 1;`,
  "packages/ui/src/button.tsx": `export default 1;`,
  "src/a.ts": `import { b } from "./b.js";\nimport u from "@app/util";\nimport { Button } from "@fx/ui";\nimport btn from "@fx/ui/button";\nimport React from "react";\nimport fs from "node:fs";\nimport m from "./missing";\n`,
  "src/b.ts": `export const b = 1;`,
  "src/util/index.ts": `export default 1;`,
  "py/pkg/__init__.py": ``,
  "py/pkg/mod.py": `from .helper import x\nfrom . import helper\nimport pkg.helper\nimport requests\n`,
  "py/pkg/helper.py": `x = 1\n`,
  "go.mod": `module fx\n\ngo 1.22\n`,
  "cmd/main.go": `package main\n\nimport "fx/internal/lib"\nimport "fmt"\n`,
  "internal/lib/a.go": `package lib\n`,
  "internal/lib/b.go": `package lib\n`,
  "internal/lib/lib_test.go": `package lib\n`,
  "rs/Cargo.toml": `[package]\nname = "fx-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n`,
  "rs/src/lib.rs": `mod util;\nuse crate::util::x;\nuse serde::Serialize;\n`,
  "rs/src/util.rs": `pub fn x() {}\nmod deep;\n`,
  "rs/src/util/deep.rs": `use super::x;\nuse crate::util;\n`,
  "java/src/main/java/a/b/Foo.java": `package a.b;\nimport a.b.Bar;\npublic class Foo {}\n`,
  "java/src/main/java/a/b/Bar.java": `package a.b;\nimport a.b.Foo;\nimport java.util.List;\npublic class Bar {}\n`,
  "java/src/test/java/a/b/FooTest.java": `package a.b;\nclass FooTest {}\n`,
  "cs/Core/Service.cs": `namespace Fx.Core;\npublic class Service {}\n`,
  "cs/Core/Model.cs": `namespace Fx.Core;\npublic class Model {}\n`,
  "cs/App/Program.cs": `using Fx.Core;\nusing System.Text;\nnamespace Fx.App;\nclass Program {}\n`,
  "cs/Tests/ServiceTests.cs": `class ServiceTests {}\n`,
  "c/src/main.c": `#include "util.h"\n#include "fx/api.h"\n#include <stdio.h>\n`,
  "c/src/util.h": `int util(void);\n`,
  "c/include/fx/api.h": `int api(void);\n`,
  "rb/lib/app.rb": `require_relative "helpers/fmt"\nrequire "json"\n`,
  "rb/lib/helpers/fmt.rb": `def fmt; end\n`,
  "php/composer.json": `{ "autoload": { "psr-4": { "Fx\\\\": "src/" } } }`,
  "php/src/Http/Controller.php": `<?php\nnamespace Fx\\Http;\nuse Fx\\Models\\User;\nrequire __DIR__ . '/routes.php';\n`,
  "php/src/Http/routes.php": `<?php\n`,
  "php/src/Models/User.php": `<?php\nnamespace Fx\\Models;\nclass User {}\n`,
  "docs/guide.md": `See [a](../src/a.ts#L3), [missing](nope.md), [space](my%20doc.md).\n`,
  "docs/my doc.md": `x\n`,
  "src/b.test.ts": `import { b } from "./b";\n`,
  "src/__tests__/util.test.ts": ``,
  "tests/pkg/test_helper.py": ``,
  "internal/lib/a_test.go": ``,
  "spec/models/user_spec.rb": ``,
  "app/models/user.rb": ``,
};
for (const [rel, text] of Object.entries(fixture)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const files = Object.keys(fixture);
// Package declarations, as the indexer would collect them from extract().
const packages = [];
for (const rel of files) {
  const lang = langOf(rel);
  if (!["jvm", "csharp", "go", "php"].includes(lang)) continue;
  const { imports, symbols } = extract(fixture[rel], rel);
  for (const i of imports) if (i.kind === "package") packages.push({ path: rel, lang, pkg: i.spec, symbols: symbols.map((s) => s.name) });
}
const R = buildResolver(root, files, { packages });
const res = (from, text) => {
  const { imports } = extract(fixture[from] ?? text, from);
  return imports.filter((i) => i.kind !== "package").map((i) => [i.spec, R.resolve(from, i)]);
};
const paths = (r) => r.map((x) => x.path || x.module);
const find = (list, spec) => (list.find(([s]) => s === spec) || [, []])[1];

check("stats", R.stats.tsconfigs === 1 && R.stats.packages === 2 && R.stats.goModules === 1 && R.stats.crates === 1, R.stats);
{
  const r = res("src/a.ts");
  check("js ./b.js → b.ts", eq(paths(find(r, "./b.js")), ["src/b.ts"]), find(r, "./b.js"));
  check("js tsconfig paths via extends", eq(paths(find(r, "@app/util")), ["src/util/index.ts"]), find(r, "@app/util"));
  check("js workspace package", eq(paths(find(r, "@fx/ui")), ["packages/ui/src/index.ts"]), find(r, "@fx/ui"));
  check("js workspace subpath", eq(paths(find(r, "@fx/ui/button")), ["packages/ui/src/button.tsx"]), find(r, "@fx/ui/button"));
  check("js external", eq(find(r, "react"), [{ module: "ext:npm:react", w: 1 }]));
  check("js node builtin", eq(paths(find(r, "node:fs")), ["ext:node:fs"]));
  check("js missing relative → []", eq(find(r, "./missing"), []));
}
{
  const r = res("py/pkg/mod.py");
  check("py relative from .helper", eq(paths(find(r, ".helper")), ["py/pkg/helper.py"]), find(r, ".helper"));
  check("py from . import helper", eq(paths(find(r, ".")), ["py/pkg/__init__.py", "py/pkg/helper.py"]), find(r, "."));
  check("py absolute via __init__ root", eq(paths(find(r, "pkg.helper")), ["py/pkg/helper.py"]), find(r, "pkg.helper"));
  check("py external", eq(paths(find(r, "requests")), ["ext:py:requests"]));
}
{
  const r = res("cmd/main.go");
  check("go package dir fan-out", eq(find(r, "fx/internal/lib"), [{ path: "internal/lib/a.go", w: 0.5 }, { path: "internal/lib/b.go", w: 0.5 }]), find(r, "fx/internal/lib"));
  check("go external", eq(paths(find(r, "fmt")), ["ext:go:fmt"]));
}
{
  const r = res("rs/src/lib.rs");
  check("rust mod util", eq(paths(find(r, "util")), ["rs/src/util.rs"]), find(r, "util"));
  check("rust use crate::util::x", eq(paths(find(r, "crate::util::x")), ["rs/src/util.rs"]), find(r, "crate::util::x"));
  check("rust external", eq(paths(find(r, "serde::Serialize")), ["ext:cargo:serde"]));
  const d = res("rs/src/util.rs");
  check("rust nested mod decl", eq(paths(find(d, "deep")), ["rs/src/util/deep.rs"]), find(d, "deep"));
  const s = res("rs/src/util/deep.rs");
  check("rust super::", eq(paths(find(s, "super::x")), ["rs/src/util.rs"]), find(s, "super::x"));
}
{
  const a = res("java/src/main/java/a/b/Foo.java");
  const b = res("java/src/main/java/a/b/Bar.java");
  check("java FQN both ways", eq(paths(find(a, "a.b.Bar")), ["java/src/main/java/a/b/Bar.java"]) && eq(paths(find(b, "a.b.Foo")), ["java/src/main/java/a/b/Foo.java"]));
  check("java external", eq(paths(find(b, "java.util.List")), ["ext:jvm:java.util"]), find(b, "java.util.List"));
  const w = R.resolve("x/Y.java", { spec: "a.b.*", kind: "import", names: ["*"] }, "jvm");
  check("java wildcard (main + test file of package a.b)", w.length === 3 && w.every((x) => x.w === 1 / 3), w);
}
{
  const r = res("cs/App/Program.cs");
  check("cs namespace fan-out", eq(paths(find(r, "Fx.Core")).sort(), ["cs/Core/Model.cs", "cs/Core/Service.cs"]) && find(r, "Fx.Core")[0].w === 0.5, find(r, "Fx.Core"));
  check("cs external", eq(paths(find(r, "System.Text")), ["ext:nuget:System"]));
}
{
  const r = res("c/src/main.c");
  check("c include same dir", eq(paths(find(r, "util.h")), ["c/src/util.h"]));
  check("c include dir", eq(paths(find(r, "fx/api.h")), ["c/include/fx/api.h"]), find(r, "fx/api.h"));
  check("c system include unresolved", eq(find(r, "stdio.h"), []));
}
{
  const r = res("rb/lib/app.rb");
  check("ruby require_relative", eq(paths(find(r, "helpers/fmt")), ["rb/lib/helpers/fmt.rb"]));
  check("ruby gem", eq(paths(find(r, "json")), ["ext:gem:json"]));
}
{
  const r = res("php/src/Http/Controller.php");
  check("php psr-4", eq(paths(find(r, "Fx\\Models\\User")), ["php/src/Models/User.php"]), find(r, "Fx\\Models\\User"));
  check("php require __DIR__", eq(paths(find(r, "./routes.php")), ["php/src/Http/routes.php"]), r);
}
{
  const r = res("docs/guide.md");
  check("md link resolves, fragment stripped", eq(paths(find(r, "../src/a.ts")), ["src/a.ts"]));
  check("md missing link → []", eq(find(r, "nope.md"), []));
  check("md %20 decoded", eq(paths(find(r, "my%20doc.md")), ["docs/my doc.md"]));
}
check("resolve never throws", eq(R.resolve("a.ts", null, "js"), []) && eq(R.resolve("a.ts", { spec: 5 }, "js"), []));

// --- tests ↔ source -------------------------------------------------------
check("testTargets js same dir", eq(testTargets("src/b.test.ts", files), ["src/b.ts"]));
check("testTargets no match → []", eq(testTargets("src/__tests__/util.test.ts", files), []), testTargets("src/__tests__/util.test.ts", files));
check("testTargets python mirrored", eq(testTargets("tests/pkg/test_helper.py", files), ["py/pkg/helper.py"]), testTargets("tests/pkg/test_helper.py", files));
check("testTargets go", eq(testTargets("internal/lib/a_test.go", files), ["internal/lib/a.go"]));
check("testTargets java src/test → src/main", eq(testTargets("java/src/test/java/a/b/FooTest.java", files), ["java/src/main/java/a/b/Foo.java"]));
check("testTargets csharp", eq(testTargets("cs/Tests/ServiceTests.cs", files), ["cs/Core/Service.cs"]));
check("testTargets ruby spec → app", eq(testTargets("spec/models/user_spec.rb", files), ["app/models/user.rb"]), testTargets("spec/models/user_spec.rb", files));
check("testTargets __tests__ parent", eq(testTargets("src/__tests__/b.test.ts", new Set([...files, "src/__tests__/b.test.ts"])), ["src/b.ts"]));
check("isTestPath", isTestPath("src/b.test.ts") && isTestPath("tests/x.py") && isTestPath("a/FooTest.java") && isTestPath("x_test.go") && !isTestPath("src/b.ts") && !isTestPath("src/latest.ts"));
rmSync(root, { recursive: true, force: true });

// --- timings --------------------------------------------------------------
{
  const chunk = `import { a${"$"}, b } from "./mod";
// a comment line with import x from 'y'
export function fn$(x: number): number {
  const s = "string // not comment";
  return x * 2;
}
export class C$ { method() { return 1; } }
const v$ = [1, 2, 3].map((n) => n + 1);
`;
  let big = "";
  for (let i = 0; big.length < 500_000; i++) big += chunk.replaceAll("$", String(i));
  extract(big, "big.ts"); // warm
  const t0 = performance.now();
  const r = extract(big, "big.ts");
  const ms = performance.now() - t0;
  console.log(`time extract ${(big.length / 1024).toFixed(0)} KB TS: ${ms.toFixed(1)} ms (${r.imports.length} imports, ${r.symbols.length} symbols)`);
  check("extract 500 KB < 50 ms", ms < 50, ms);
}
{
  const many = [];
  for (let i = 0; i < 100_000; i++) many.push(`pkg${i % 50}/src/dir${i % 400}/file${i}.ts`);
  const t0 = performance.now();
  const RR = buildResolver(tmpdir(), many);
  const t1 = performance.now();
  let hits = 0;
  for (let i = 0; i < 100_000; i++) {
    const from = many[i];
    const spec = i % 3 === 0 ? `./file${i + 400}` : i % 3 === 1 ? `../dir${(i + 1) % 400}/file${i}.js` : "lodash/fp";
    hits += RR.resolve(from, { spec, kind: "import", names: [] }, "js").length;
  }
  const t2 = performance.now();
  console.log(`time resolver build ${(t1 - t0).toFixed(0)} ms + 100k resolves ${(t2 - t1).toFixed(0)} ms (${hits} results)`);
  check("resolver 100k < 2 s", t2 - t0 < 2000, t2 - t0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
