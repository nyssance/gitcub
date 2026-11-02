// Desktop's usage-data helper, adapted to TS7's native type-query API.
// Preserve the upstream example-value rules. This file runs in a child process without the
// test platform shims, so it must not import production modules.
import assert from "node:assert/strict"
import { resolve } from "node:path"

import type { TypeNode } from "typescript/unstable/ast"
import {
  isLiteralTypeNode,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode
} from "typescript/unstable/ast/is"
import { API, type Checker, SymbolFlags, type Type, TypeFlags } from "typescript/unstable/async"

// TS7 may reorder union members. Keep the source-declared first literal, as
// the original generator did (e.g. Architecture starts with "x64").
async function firstLiteral(node: TypeNode | undefined, checker: Checker, depth = 0): Promise<string | undefined> {
  if (!node || depth > 32) return undefined
  if (isLiteralTypeNode(node) && isStringLiteral(node.literal)) return node.literal.text
  if (isUnionTypeNode(node)) {
    for (const member of node.types) {
      const value = await firstLiteral(member, checker, depth + 1)
      if (value !== undefined) return value
    }
  }
  if (isTypeReferenceNode(node)) {
    let symbol = await checker.getSymbolAtLocation(node.typeName)
    if (symbol) {
      if (symbol.flags & SymbolFlags.Alias) symbol = await checker.getAliasedSymbol(symbol)
      for (const handle of symbol.declarations) {
        const declaration = await handle.resolve()
        if (declaration && isTypeAliasDeclaration(declaration)) {
          return await firstLiteral(declaration.type, checker, depth + 1)
        }
      }
    }
  }
  return undefined
}

async function exampleValue(
  type: Type,
  preferredLiteral: string | undefined
): Promise<string | number | boolean | null> {
  const members = type.isUnionType() ? await type.getTypes() : undefined
  const types = (members ?? [type]).filter(t => !(t.flags & TypeFlags.Undefined))
  const has = (flag: TypeFlags) => types.some(t => (t.flags & flag) !== 0)
  if (has(TypeFlags.Null)) return null
  if (has(TypeFlags.Number | TypeFlags.NumberLiteral | TypeFlags.NumberLike)) return 1
  if (has(TypeFlags.Boolean | TypeFlags.BooleanLiteral | TypeFlags.BooleanLike)) return true
  if (preferredLiteral !== undefined && types.some(t => t.isStringLiteralType() && t.value === preferredLiteral)) {
    return preferredLiteral
  }
  const literal = types.find(t => t.isStringLiteralType())
  if (literal?.isStringLiteralType()) return literal.value
  if (has(TypeFlags.String | TypeFlags.StringLiteral | TypeFlags.StringLike)) return "example"
  throw new Error(`Unsupported stats property type: ${type.flags}`)
}

/** Property name → example value for DailyStats, computed over the async TS7 API. */
export async function computeUsageDataEntries(): Promise<Record<string, string | number | boolean | null>> {
  const api = new API({ cwd: process.cwd() })
  try {
    using snapshot = await api.updateSnapshot({ openProjects: [resolve("tsconfig.json")] })
    const project = snapshot.getProject(resolve("tsconfig.json"))
    assert.ok(project, "Could not open the application TypeScript project")
    const source = await project.program.getSourceFile(resolve("src/lib/stats/stats-store.ts"))
    assert.ok(source)
    const declaration = source.statements.find(s => isTypeAliasDeclaration(s) && s.name.text === "DailyStats")
    assert.ok(declaration, "Could not find the DailyStats type alias")
    const type = await project.checker.getTypeAtLocation(declaration)
    assert.ok(type)
    const entries: Array<[string, string | number | boolean | null]> = []
    for (const property of await project.checker.getPropertiesOfType(type)) {
      const node = await (property.valueDeclaration ?? property.declarations[0])?.resolve()
      assert.ok(node, `Could not find the declaration for ${property.name}`)
      entries.push([
        property.name,
        await exampleValue(
          await project.checker.getTypeOfSymbolAtLocation(property, node),
          await firstLiteral(isPropertySignatureDeclaration(node) ? node.type : undefined, project.checker)
        )
      ])
    }
    return Object.fromEntries(entries)
  } finally {
    // tsgo may still owe a response when the connection closes; the child process exits right after.
    api.close().catch(() => {})
  }
}

if (process.argv.includes("--print")) {
  const json = JSON.stringify(await computeUsageDataEntries())
  await new Promise<void>(done => process.stdout.write(json, () => done()))
  process.exit(0)
}
