/**
 * Offline verification for `$ref` inlining.
 *
 * This is the regression test for the reverse-mode 400: pi-ai projects tools to
 * `{type, properties, required}` for models without strict tool sampling, which
 * drops `$defs`; REA's schemas reference `#/$defs/…`, so they must be inlined
 * before registration.
 *
 * Run: node test/schema.test.mjs
 */

import assert from 'node:assert/strict'

import { hasRefs, inlineSchemaRefs } from '../lib/schema.js'

let failures = 0
/**
 * @param name - Test name.
 * @param fn - Test body.
 */
function test(name, fn) {
  try {
    fn()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}\n     ${String(error?.message ?? error)}\n`)
  }
}

test('inlines a top-level $ref and drops the definitions table', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { $ref: '#/$defs/Path' },
      mode: { type: 'string' },
    },
    required: ['path'],
    $defs: { Path: { type: 'string', description: 'file path' } },
  }
  const out = inlineSchemaRefs(schema)
  assert.deepEqual(out.properties.path, { type: 'string', description: 'file path' })
  assert.equal(out.properties.mode.type, 'string')
  assert.deepEqual(out.required, ['path'])
  assert.equal(out.$defs, undefined)
  assert.equal(hasRefs(out), false)
})

test('resolves nested and array references', () => {
  const schema = {
    type: 'object',
    properties: {
      targets: { type: 'array', items: { $ref: '#/$defs/Target' } },
    },
    $defs: {
      Target: {
        type: 'object',
        properties: { name: { type: 'string' }, kind: { $ref: '#/$defs/Kind' } },
        required: ['name'],
      },
      Kind: { type: 'string', enum: ['binary', 'package'] },
    },
  }
  const out = inlineSchemaRefs(schema)
  const items = out.properties.targets.items
  assert.equal(items.type, 'object')
  assert.equal(items.properties.kind.type, 'string')
  assert.deepEqual(items.properties.kind.enum, ['binary', 'package'])
  assert.equal(hasRefs(out), false)
})

test('merges $ref siblings over the definition', () => {
  const out = inlineSchemaRefs({
    type: 'object',
    properties: { count: { $ref: '#/$defs/Count', description: 'how many', default: 3 } },
    $defs: { Count: { type: 'integer', minimum: 1 } },
  })
  assert.deepEqual(out.properties.count, { type: 'integer', minimum: 1, description: 'how many', default: 3 })
})

test('supports the legacy definitions table', () => {
  const out = inlineSchemaRefs({
    type: 'object',
    properties: { x: { $ref: '#/definitions/X' } },
    definitions: { X: { type: 'number' } },
  })
  assert.deepEqual(out.properties.x, { type: 'number' })
  assert.equal(out.definitions, undefined)
})

test('recursive references degrade to an object instead of dangling', () => {
  const out = inlineSchemaRefs({
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
  })
  assert.equal(out.properties.node.type, 'object')
  assert.equal(out.properties.node.properties.child.type, 'object')
  assert.equal(hasRefs(out), false)
})

test('unresolved and external references degrade safely', () => {
  const out = inlineSchemaRefs({
    type: 'object',
    properties: {
      missing: { $ref: '#/$defs/Nope' },
      remote: { $ref: 'https://example.com/schema.json' },
    },
  })
  assert.deepEqual(out.properties.missing, { type: 'object' })
  assert.deepEqual(out.properties.remote, { type: 'object' })
  assert.equal(hasRefs(out), false)
})

test('a schema without references passes through', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  }
  assert.deepEqual(inlineSchemaRefs(schema), schema)
})

test('non-object input yields a permissive object schema', () => {
  for (const value of [undefined, null, 42, 'x', []]) {
    assert.deepEqual(inlineSchemaRefs(value), { type: 'object', properties: {} })
  }
})

test('does not mutate the input', () => {
  const schema = {
    type: 'object',
    properties: { path: { $ref: '#/$defs/Path' } },
    $defs: { Path: { type: 'string' } },
  }
  const snapshot = JSON.parse(JSON.stringify(schema))
  inlineSchemaRefs(schema)
  assert.deepEqual(schema, snapshot)
})

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1