/**
 * JSON Schema `$ref` inlining for MCP tool definitions.
 *
 * Why this exists
 * ---------------
 * pi-ai projects every tool schema down to `{ type, properties, required }`
 * before sending it to Anthropic-compatible models that do not advertise strict
 * tool sampling. That projection **drops `$defs`**, so any schema written as
 * `properties: { x: { $ref: '#/$defs/Foo' } }, $defs: { Foo: … }` reaches the
 * provider with a dangling reference and the whole request fails:
 *
 *     HTTP 400 {"model":"deepseek-flash"}
 *
 * REA's MCP catalog uses exactly that pattern (158 of 170 tools), which is why
 * the failure only shows up in the reverse-mode preset — the ordinary toolbox
 * has no `$ref`s. Inlining the referenced definitions into `properties` before
 * registration keeps the schema self-contained, so the projection stays valid
 * and the same catalog works on both strict and non-strict models.
 *
 * The transformation is conservative: only local `#/$defs/…` and
 * `#/definitions/…` pointers are resolved, siblings of `$ref` are merged over
 * the target, unresolved or recursive references degrade to `{ type: 'object' }`
 * (never a dangling `$ref`), and non-JSON-Schema data is left untouched.
 *
 * @module dsh-reverse-mode/schema
 */

/** Root prefixes this module knows how to resolve. */
const REF_ROOTS = ['#/$defs/', '#/definitions/']

/** Replacement for a reference this build cannot resolve safely. */
const FALLBACK = Object.freeze({ type: 'object' })

/**
 * @param value - Any JSON value.
 * @returns whether it is a non-array object.
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Resolve one local JSON pointer to its definition.
 *
 * @param ref - The `$ref` string.
 * @param root - The schema that owns `$defs` / `definitions`.
 * @returns the target schema, or undefined when it is not a local definition.
 */
function resolveRef(ref, root) {
  for (const prefix of REF_ROOTS) {
    if (!ref.startsWith(prefix)) continue
    const name = ref.slice(prefix.length)
    const container = prefix === '#/$defs/' ? root.$defs : root.definitions
    if (isObject(container) && isObject(container[name])) return container[name]
  }
  return undefined
}

/**
 * Inline local `$ref`s in a schema.
 *
 * @param schema - The schema to transform.
 * @param root - The schema that owns the `$defs` / `definitions` tables.
 * @param active - Names currently being expanded, to stop recursive cycles.
 * @returns a schema with no local `$ref` left behind.
 */
function inlineNode(schema, root, active) {
  if (Array.isArray(schema)) return schema.map((item) => inlineNode(item, root, active))
  if (!isObject(schema)) return schema

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root)
    // A cycle cannot be represented inline; objects are the safe degradation.
    if (target === undefined || active.has(schema.$ref)) return { ...FALLBACK }
    const { $ref: _ref, ...siblings } = schema
    const merged = { ...target, ...siblings }
    const expanded = inlineNode(merged, root, new Set(active).add(schema.$ref))
    return expanded
  }

  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    // The definitions are now part of `properties`; keeping the table would
    // just duplicate bytes that the legacy projection drops anyway.
    if (key === '$defs' || key === 'definitions') continue
    out[key] = inlineNode(value, root, active)
  }
  return out
}

/**
 * Inline `$defs` / `definitions` references so a schema survives a projection
 * that keeps only `type`, `properties` and `required`.
 *
 * Safe to call on any schema: a schema without local references comes back
 * structurally unchanged apart from dropping its `$defs` table.
 *
 * @param schema - The tool `inputSchema`.
 * @returns the self-contained schema, or a permissive object schema when the
 * input is not an object.
 */
export function inlineSchemaRefs(schema) {
  if (!isObject(schema)) return { type: 'object', properties: {} }
  try {
    return inlineNode(schema, schema, new Set())
  } catch {
    // A pathological schema must not break tool registration.
    return { type: 'object', properties: {} }
  }
}

/**
 * Whether a schema still contains a local `$ref`.
 *
 * @param schema - A JSON value to scan.
 * @returns whether any `$ref` string remains.
 */
export function hasRefs(schema) {
  if (Array.isArray(schema)) return schema.some(hasRefs)
  if (!isObject(schema)) return false
  if (typeof schema.$ref === 'string') return true
  return Object.values(schema).some(hasRefs)
}