import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import type { Command } from '../../src/editor/commands'
import { runCommand } from '../../src/editor/commands/runCommand'
import { peek, resetStates } from '../../src/history/stack'
import type { State } from '../../src/state'
import { initialStep, originOperation } from '../helpers/historySteps'
import { callSites } from './peekCallSites'

const root = new URL('../../', import.meta.url)

const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
    .map((path) => `src/${path.replaceAll('\\', '/')}`)
    .filter((path) => /\.(ts|vue)$/.test(path))
    .map((path) => ({ path, source: readFileSync(new URL(path, root), 'utf8') }))

const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0

test('commands run only through runCommand', () => {
    const callers = sources
        .filter(({ source }) => source.includes('.execute('))
        .map(({ path }) => path)
    assert.deepEqual(callers, ['src/editor/commands/runCommand.ts'])
})

const fakeCommand = (readOnly: boolean) => {
    const runs: number[] = []
    const command: Command = {
        title: () => '',
        icon: { is: {} },
        execute: () => {
            runs.push(1)
        },
        ...(readOnly && { readOnly: true }),
    }
    return { command, runs }
}

test('while peeking, runCommand runs only read-only commands', () => {
    resetStates({ isDirty: false, step: initialStep(originOperation()), state: {} as State })
    const edit = fakeCommand(false)
    const view = fakeCommand(true)

    runCommand(edit.command)
    runCommand(view.command)
    assert.equal(edit.runs.length, 1)
    assert.equal(view.runs.length, 1)

    peek.value = { source: 'test', state: {} as State }
    runCommand(edit.command)
    runCommand(view.command)
    assert.equal(edit.runs.length, 1)
    assert.equal(view.runs.length, 2)
    peek.value = undefined
})

test('every direct pushState and replaceState call site is listed with its gate', () => {
    const found = Object.fromEntries(
        sources.flatMap(({ path, source }) => {
            const push = count(source, /\bpushState\(/g)
            const replace = count(source, /\breplaceState\(/g)
            return push || replace ? [[path, { push, replace }]] : []
        }),
    )
    const listed = Object.fromEntries(
        Object.entries(callSites).map(([path, { push, replace }]) => [path, { push, replace }]),
    )
    assert.deepEqual(found, listed)
})
