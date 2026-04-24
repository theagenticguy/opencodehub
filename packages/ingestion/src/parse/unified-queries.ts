/**
 * Unified cross-language S-expression queries.
 *
 * Clean-room authored from tree-sitter's code-navigation tag vocabulary:
 *   @definition.{class,function,method,interface,module,macro,constant,type}
 *   @reference.{call,class,type,interface,implementation,send}
 *   @name (inner capture for identifier substrings)
 *
 * Each query is intentionally MINIMAL — just enough for MVP symbol extraction
 * downstream. No `@doc` capture at MVP (comment extraction deferred).
 *
 * These queries are authored independently from grammar tags.scm files by
 * reading only the grammar's public AST node type names. No text is copied
 * from any external source. License: Apache-2.0.
 */

import type { LanguageId } from "./types.js";

// ---------------------------------------------------------------------------
// TYPESCRIPT (also reused for TSX)
// ---------------------------------------------------------------------------
// AST highlights: class_declaration, interface_declaration, function_declaration,
// method_definition, type_alias_declaration, abstract_class_declaration,
// lexical_declaration (const), call_expression, new_expression.
const TYPESCRIPT_QUERY = `
; --- classes ---
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class

; --- interfaces ---
(interface_declaration name: (type_identifier) @name) @definition.interface

; --- type aliases ---
(type_alias_declaration name: (type_identifier) @name) @definition.type

; --- enums ---
(enum_declaration name: (identifier) @name) @definition.type

; --- modules / namespaces ---
(module name: (identifier) @name) @definition.module
(internal_module name: (identifier) @name) @definition.module

; --- functions ---
(function_declaration name: (identifier) @name) @definition.function

; --- methods ---
(method_definition name: (property_identifier) @name) @definition.method

; --- constants (top-level const/let) ---
(lexical_declaration
  (variable_declarator name: (identifier) @name)) @definition.constant

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(type_identifier) @name @reference.type
(implements_clause (type_identifier) @name @reference.interface)
`;

// ---------------------------------------------------------------------------
// JAVASCRIPT (ES2022 + JSX)
// ---------------------------------------------------------------------------
const JAVASCRIPT_QUERY = `
; --- classes ---
(class_declaration name: (identifier) @name) @definition.class

; --- functions ---
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function

; --- methods ---
(method_definition name: (property_identifier) @name) @definition.method

; --- constants ---
(lexical_declaration
  (variable_declarator name: (identifier) @name)) @definition.constant

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
`;

// ---------------------------------------------------------------------------
// PYTHON
// ---------------------------------------------------------------------------
// AST highlights: class_definition, function_definition, assignment
// (top-level const, class-body property).
const PYTHON_QUERY = `
; --- classes ---
(class_definition name: (identifier) @name) @definition.class

; --- functions and methods share the same grammar node ---
; A function is a method when it is nested inside a class_definition body.
(function_definition name: (identifier) @name) @definition.function

; --- top-level constants ---
; @definition.constant is attached to the assignment itself so each
; assignment produces a single, tightly-scoped definition record.
(module
  (expression_statement
    (assignment
      left: (identifier) @name) @definition.constant))

; --- class-body properties (typed and untyped) ---
; Properties emitted for attributes defined at class-body scope. Typed
; (\`x: int = 0\`) and untyped (\`x = 0\`) both fire; the extractor dedupes
; overlapping captures and keeps the typed tag when both match the same
; AST range.
(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name
        type: (type)) @definition.property)))
(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name) @definition.property)))

; --- function-body locals ---
; Plain assignments inside a function body. Emitted as Variable nodes by the
; extractor (classifyAssignment dispatches on enclosing-scope kind). The
; innermostEnclosingDef CALLS-ownership filter excludes Variable/Property/
; Const/Variable tags, so these locals cannot hijack call-edge attribution.
(function_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name) @definition.variable)))
(function_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name
        type: (type)) @definition.variable)))

; --- references ---
(call function: (identifier) @name) @reference.call
(call function: (attribute attribute: (identifier) @name)) @reference.call

; --- class references (bases of a class) ---
(class_definition
  superclasses: (argument_list (identifier) @name @reference.class))
`;

// ---------------------------------------------------------------------------
// GO
// ---------------------------------------------------------------------------
// AST highlights: type_declaration (struct_type, interface_type), function_declaration,
// method_declaration, package_clause, const_declaration, call_expression.
const GO_QUERY = `
; --- package as module ---
(package_clause (package_identifier) @name) @definition.module

; --- type declarations ---
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type))) @definition.class

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type))) @definition.interface

(type_declaration
  (type_spec name: (type_identifier) @name)) @definition.type

; --- functions and methods ---
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method

; --- constants ---
(const_declaration
  (const_spec name: (identifier) @name)) @definition.constant

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call
(type_identifier) @name @reference.type
`;

// ---------------------------------------------------------------------------
// RUST
// ---------------------------------------------------------------------------
// AST highlights: struct_item, enum_item, union_item, trait_item, impl_item,
// function_item, mod_item, const_item, macro_definition, call_expression.
const RUST_QUERY = `
; --- structs / enums / unions all map to class-like ---
(struct_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.class
(union_item name: (type_identifier) @name) @definition.class

; --- traits map to interface ---
(trait_item name: (type_identifier) @name) @definition.interface

; --- modules ---
(mod_item name: (identifier) @name) @definition.module

; --- functions (file-level) and methods (inside an impl block) ---
(function_item name: (identifier) @name) @definition.function

; --- constants ---
(const_item name: (identifier) @name) @definition.constant

; --- macros ---
(macro_definition name: (identifier) @name) @definition.macro

; --- impl blocks act as implementations ---
(impl_item type: (type_identifier) @name) @reference.implementation

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (scoped_identifier path: (identifier) name: (identifier) @name)) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(type_identifier) @name @reference.type
`;

// ---------------------------------------------------------------------------
// JAVA
// ---------------------------------------------------------------------------
// AST highlights: class_declaration, interface_declaration, method_declaration,
// constructor_declaration, enum_declaration, method_invocation, object_creation_expression.
const JAVA_QUERY = `
; --- classes ---
(class_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class

; --- interfaces ---
(interface_declaration name: (identifier) @name) @definition.interface

; --- methods + constructors ---
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method

; --- references ---
(method_invocation name: (identifier) @name) @reference.call
(object_creation_expression type: (type_identifier) @name) @reference.class

; --- implements clause ---
(superclass (type_identifier) @name @reference.class)
(super_interfaces (type_list (type_identifier) @name @reference.implementation))
`;

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------
// AST highlights: class_declaration, interface_declaration, method_declaration,
// constructor_declaration, namespace_declaration, struct_declaration,
// record_declaration, invocation_expression, object_creation_expression.
const CSHARP_QUERY = `
; --- namespaces as modules ---
(namespace_declaration name: (identifier) @name) @definition.module
(namespace_declaration name: (qualified_name) @name) @definition.module

; --- classes / structs / records ---
(class_declaration name: (identifier) @name) @definition.class
(struct_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class

; --- interfaces ---
(interface_declaration name: (identifier) @name) @definition.interface

; --- methods + constructors ---
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method

; --- references ---
(invocation_expression
  function: (member_access_expression name: (identifier) @name)) @reference.send
(invocation_expression
  function: (identifier) @name) @reference.call
(object_creation_expression type: (identifier) @name) @reference.class
`;

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------
// AST highlights: function_definition, struct_specifier, union_specifier,
// enum_specifier, type_definition, preproc_def, call_expression,
// function_declarator.
const C_QUERY = `
; --- functions: name sits on the function_declarator inside the definition ---
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

; --- pointer-returning functions wrap the declarator in pointer_declarator ---
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @name))) @definition.function

; --- structs / unions ---
(struct_specifier name: (type_identifier) @name body: (_)) @definition.class
(union_specifier name: (type_identifier) @name body: (_)) @definition.union

; --- enums ---
(enum_specifier name: (type_identifier) @name) @definition.enum

; --- typedefs ---
(type_definition declarator: (type_identifier) @name) @definition.type

; --- macros ---
(preproc_def name: (identifier) @name) @definition.macro
(preproc_function_def name: (identifier) @name) @definition.macro

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
`;

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------
// AST highlights: class_specifier, struct_specifier, namespace_definition,
// template_declaration, function_definition, field_declaration (methods),
// base_class_clause, call_expression, preproc_include.
const CPP_QUERY = `
; --- classes / structs ---
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct

; --- namespaces ---
(namespace_definition name: (namespace_identifier) @name) @definition.module

; --- functions (free + member bodies) ---
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.method

(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @name))) @definition.method

(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (field_identifier) @name))) @definition.method

; --- templates (wrapper: we still emit inner class/function separately) ---
(template_declaration) @definition.template

; --- enums ---
(enum_specifier name: (type_identifier) @name) @definition.enum

; --- typedefs / type aliases ---
(type_definition declarator: (type_identifier) @name) @definition.type
(alias_declaration name: (type_identifier) @name) @definition.type

; --- macros ---
(preproc_def name: (identifier) @name) @definition.macro
(preproc_function_def name: (identifier) @name) @definition.macro

; --- base classes ---
(base_class_clause (type_identifier) @name @reference.class)

; --- references ---
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression
  function: (qualified_identifier name: (identifier) @name)) @reference.call
`;

// ---------------------------------------------------------------------------
// RUBY
// ---------------------------------------------------------------------------
// AST highlights: class, module, method, singleton_method, call, superclass,
// assignment (top-level const), identifier/constant.
const RUBY_QUERY = `
; --- classes ---
(class name: (constant) @name) @definition.class

; --- modules ---
(module name: (constant) @name) @definition.module

; --- instance methods ---
(method name: (identifier) @name) @definition.function

; --- class / singleton methods ---
(singleton_method name: (identifier) @name) @definition.function

; --- top-level constants (CAPS assignment) ---
(assignment left: (constant) @name) @definition.constant

; --- superclass reference: class Foo < Bar ---
(class (superclass (constant) @name @reference.class))

; --- calls ---
(call method: (identifier) @name) @reference.call

; --- include/extend/prepend mixins (detected by callee name in the call node) ---
((call
   method: (identifier) @_m
   arguments: (argument_list (constant) @name @reference.mixin))
 (#match? @_m "^(include|extend|prepend)$"))
`;

// ---------------------------------------------------------------------------
// KOTLIN
// ---------------------------------------------------------------------------
// AST highlights: class_declaration, object_declaration, function_declaration,
// property_declaration, call_expression, delegation_specifier, import_header,
// interface (inside class_declaration for interface variant).
const KOTLIN_QUERY = `
; --- classes / interfaces / objects ---
(class_declaration
  (type_identifier) @name) @definition.class

(object_declaration
  (type_identifier) @name) @definition.module

; --- functions / methods ---
(function_declaration
  (simple_identifier) @name) @definition.function

; --- properties ---
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.property

; --- delegation / inheritance: ": Parent, Iface" ---
(delegation_specifier
  (user_type (type_identifier) @name @reference.class))

(delegation_specifier
  (constructor_invocation
    (user_type (type_identifier) @name @reference.class)))

; --- calls ---
(call_expression
  (simple_identifier) @name) @reference.call

(call_expression
  (navigation_expression
    (navigation_suffix (simple_identifier) @name))) @reference.call
`;

// ---------------------------------------------------------------------------
// SWIFT
// ---------------------------------------------------------------------------
// AST highlights: class_declaration (covers class/struct/enum/actor/extension
// via a `declaration_kind` field), protocol_declaration, function_declaration,
// init_declaration, property_declaration, call_expression,
// inheritance_specifier, import_declaration.
const SWIFT_QUERY = `
; --- class / struct / enum / extension (declaration_kind disambiguates) ---
(class_declaration
  name: (type_identifier) @name) @definition.class

; --- protocols ---
(protocol_declaration
  name: (type_identifier) @name) @definition.interface

; --- functions / methods ---
(function_declaration
  name: (simple_identifier) @name) @definition.function

; --- initializers ---
(init_declaration) @definition.constructor

; --- inheritance / protocol conformance ---
(inheritance_specifier
  (user_type (type_identifier) @name @reference.class))

; --- calls: bare identifier callee ---
(call_expression
  (simple_identifier) @name) @reference.call

; --- calls: obj.method() via navigation_expression ---
(call_expression
  (navigation_expression
    (navigation_suffix (simple_identifier) @name))) @reference.call
`;

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------
// AST highlights: class_declaration, interface_declaration, trait_declaration,
// method_declaration, function_definition, namespace_use_declaration,
// function_call_expression, base_clause, class_interface_clause, use_declaration.
const PHP_QUERY = `
; --- classes / interfaces / traits ---
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait

; --- namespaces ---
(namespace_definition name: (namespace_name) @name) @definition.module

; --- enums (PHP 8.1+) ---
(enum_declaration name: (name) @name) @definition.enum

; --- functions / methods ---
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method

; --- base (extends) class ---
(base_clause (name) @name @reference.class)

; --- implemented interfaces ---
(class_interface_clause (name) @name @reference.interface)

; --- trait use inside a class body ---
(use_declaration (name) @name @reference.mixin)

; --- calls ---
(function_call_expression function: (name) @name) @reference.call
(member_call_expression name: (name) @name) @reference.call
(scoped_call_expression name: (name) @name) @reference.call
`;

// ---------------------------------------------------------------------------
// DART
// ---------------------------------------------------------------------------
// AST highlights: class_definition, mixin_declaration, extension_declaration,
// function_signature, method_signature, constructor_signature, superclass,
// mixins, interfaces, import_or_export.
const DART_QUERY = `
; --- classes ---
(class_definition
  name: (identifier) @name) @definition.class

; --- mixins ---
(mixin_declaration
  (identifier) @name) @definition.mixin

; --- extensions ---
(extension_declaration
  name: (identifier) @name) @definition.module

; --- enums ---
(enum_declaration name: (identifier) @name) @definition.enum

; --- functions (top-level) ---
(function_signature
  name: (identifier) @name) @definition.function

; --- methods (inside a class body) ---
(method_signature
  (function_signature
    name: (identifier) @name)) @definition.method

; --- constructors ---
(constructor_signature) @definition.constructor

; --- superclass: extends Parent ---
(superclass (type_identifier) @name @reference.class)

; --- interfaces: implements I1, I2 ---
(interfaces (type_identifier) @name @reference.interface)

; --- mixins: with M1, M2 (lives inside a superclass node in Dart grammar) ---
(mixins (type_identifier) @name @reference.mixin)
`;

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const QUERIES: Record<LanguageId, string> = {
  typescript: TYPESCRIPT_QUERY,
  tsx: TYPESCRIPT_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  java: JAVA_QUERY,
  csharp: CSHARP_QUERY,
  c: C_QUERY,
  cpp: CPP_QUERY,
  ruby: RUBY_QUERY,
  kotlin: KOTLIN_QUERY,
  swift: SWIFT_QUERY,
  php: PHP_QUERY,
  dart: DART_QUERY,
};

/** Return the unified S-expression query body for a given language. */
export function getUnifiedQuery(lang: LanguageId): string {
  return QUERIES[lang];
}
