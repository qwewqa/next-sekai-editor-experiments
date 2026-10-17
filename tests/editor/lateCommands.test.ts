import assert from 'node:assert/strict'
import test from 'node:test'
import Type from 'typebox'
import Value from 'typebox/value'
import { shallowReactive } from 'vue'
import { matchBindings } from '../../src/editor/controls/bindings'
import { registeredGroups, toolbarGroups } from '../../src/editor/toolbar/layout'
import { storedBindings, storedNames } from '../../src/settingsCodecs'

// The command registry has the same shape: reactive, and registered names are the keys.
const registry = shallowReactive<Record<string, unknown>>({ copy: {} })
const isRegistered = (name: string): name is string => name in registry

const roundTrip = <T extends Type.TSchema>(schema: T, stored: unknown) => {
    const decoded = Value.Decode(schema, Value.Repair(schema, stored))
    return { decoded, encoded: Value.Encode(schema, decoded) }
}

const press = (key: string) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
})

test('a toolbar layout and a binding naming an unregistered command survive and resolve on registering', () => {
    const stored = [['ghost', 'copy'], ['ghost']]
    const toolbar = roundTrip(Type.Array(storedNames(), { default: [] }), stored)
    assert.deepEqual(toolbar.decoded, stored)
    assert.deepEqual(toolbar.encoded, stored)

    const bindings = roundTrip(storedBindings({}), { ghost: 'F9', copy: 'c' })
    assert.deepEqual(bindings.decoded, { ghost: 'F9', copy: 'c' })
    assert.deepEqual(bindings.encoded, { ghost: 'F9', copy: 'c' })

    const resolved = () =>
        toolbarGroups(registeredGroups(toolbar.decoded, isRegistered)).slice(0, -1)
    const bound = () =>
        matchBindings(bindings.decoded, press('F9'), false).names.filter(isRegistered)
    assert.deepEqual(resolved(), [['copy']])
    assert.deepEqual(bound(), [])

    registry.ghost = {}
    assert.deepEqual(resolved(), [['ghost', 'copy'], ['ghost']])
    assert.deepEqual(bound(), ['ghost'])
})
