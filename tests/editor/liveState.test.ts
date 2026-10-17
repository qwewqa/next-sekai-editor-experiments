import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import test from 'node:test'
import {
    isPeeking,
    liveState,
    peek,
    pushState,
    replaceState,
    resetStates,
    state,
} from '../../src/history/stack'
import type { State } from '../../src/state'

const root = new URL('../../', import.meta.url)

const fakeState = (name: string) => ({ name }) as unknown as State

const start = () => {
    const first = fakeState('first')
    const second = fakeState('second')
    resetStates({ isDirty: false, name: () => 'first', state: first })
    pushState(() => 'second', second)
    return second
}

test('with a peek set, state is the peeked state and liveState the current one', () => {
    const current = start()
    assert.equal(state.value, current)
    assert.equal(liveState.value, current)
    assert.equal(isPeeking.value, false)

    const peeked = fakeState('peeked')
    peek.value = { source: 'test', state: peeked }
    assert.equal(isPeeking.value, true)
    assert.equal(state.value, peeked)
    assert.equal(liveState.value, current)

    peek.value = undefined
    assert.equal(state.value, current)
})

test('pushState while peeking throws in tests and changes nothing', () => {
    const current = start()
    const peeked = fakeState('peeked')
    peek.value = { source: 'test', state: peeked }

    assert.throws(() => {
        pushState(() => 'edit', fakeState('edit'))
    })
    assert.equal(liveState.value, current)
    assert.equal(state.value, peeked)
    peek.value = undefined
})

test('replaceState while peeking changes only the peeked state', () => {
    const current = start()
    peek.value = { source: 'test', state: fakeState('peeked') }

    const selected = fakeState('selected')
    replaceState(selected)
    assert.equal(state.value, selected)
    assert.equal(peek.value.source, 'test')
    assert.equal(liveState.value, current)
    peek.value = undefined
})

test('resetting the history leaves the peek', () => {
    start()
    peek.value = { source: 'test', state: fakeState('peeked') }

    const reset = fakeState('reset')
    resetStates({ isDirty: false, name: () => 'reset', state: reset })
    assert.equal(isPeeking.value, false)
    assert.equal(state.value, reset)
})

// The names each module imports from src/history, by module ('index' for src/history itself).
const historyImports = (file: string) => {
    const source = readFileSync(new URL(file, root), 'utf8')
    const imports = new Map<string, string[]>()
    for (const [, names = '', specifier = ''] of source.matchAll(
        /^import\s+\{([^}]*)\}\s+from\s+'([^']+)'/gm,
    )) {
        if (!specifier.startsWith('.')) continue
        const target = posix
            .normalize(posix.join(posix.dirname(file), specifier))
            .replace(/\.ts$/, '')
        const module =
            target === 'src/history'
                ? 'index'
                : target.startsWith('src/history/')
                  ? target.slice('src/history/'.length)
                  : undefined
        if (!module) continue
        const list = names
            .split(',')
            .map((name) => name.trim().split(/\s+as\s+/)[0] ?? '')
            .filter((name) => name && !name.startsWith('type '))
        imports.set(module, [...(imports.get(module) ?? []), ...list])
    }
    return imports
}

// The display computeds: what a writer reads from them follows a peek.
const displayModules = [
    'bgm',
    'bpms',
    'dynamicStages',
    'filename',
    'groups',
    'initialLife',
    'selectedEntities',
    'stages',
    'store',
]

/**
 * The writer audit: modules that act on the live session while peeking, and the live state they
 * import. Every other history consumer displays the peeked state, or is gated while peeking.
 */
const writers: {
    file: string
    imports: Record<string, string[]>
    /** It also reads the displayed chart, as playback does. */
    readsDisplay?: true
}[] = [
    // Today's Save serializer, which becomes Export.
    { file: 'src/editor/commands/save/index.ts', imports: { live: ['filename'] } },
    { file: 'src/editor/commands/exportLevel/index.ts', imports: { live: ['filename'] } },
    // Save and Export build level data here.
    {
        file: 'src/editor/commands/exportLevel/build.ts',
        imports: {
            live: [
                'bgm',
                'groupFolders',
                'groups',
                'initialLife',
                'isDynamicStages',
                'stageFolders',
                'stages',
                'store',
            ],
        },
    },
    { file: 'src/history/autoSave/index.ts', imports: { live: ['filename'] } },
    // Playback keeps the live BGM's audio, on the displayed chart.
    { file: 'src/player.ts', imports: { bgm: ['playbackBgm'] }, readsDisplay: true },
    { file: 'src/editor/commands/bgm/BgmModal.vue', imports: { index: ['liveState'] } },
    {
        file: 'src/editor/commands/bgm/index.ts',
        imports: { index: ['liveState'], live: ['bgm'] },
    },
]

for (const { file, imports: required, readsDisplay } of writers) {
    test(`${file} reads liveState`, () => {
        const imports = historyImports(file)
        for (const [module, names] of Object.entries(required))
            for (const name of names)
                assert.ok(imports.get(module)?.includes(name), `${name} from history/${module}`)

        if (readsDisplay) return
        assert.ok(!imports.get('index')?.includes('state'), 'state from history')
        for (const module of displayModules)
            assert.ok(!imports.has(module), `display computeds from history/${module}`)
    })
}

test('the live computeds read only liveState', () => {
    const source = readFileSync(new URL('src/history/live.ts', root), 'utf8')
    assert.match(source, /import \{ liveState \} from '\.\/stack'/)
    assert.doesNotMatch(source, /\bstate\.value\b/)
})

test('auto save serializes liveState', () => {
    const imports = historyImports('src/history/autoSave/index.ts')
    assert.ok(imports.get('index')?.includes('liveState'))
    assert.ok(!imports.get('index')?.includes('state'))
})
