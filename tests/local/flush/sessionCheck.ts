import assert from 'node:assert/strict'
import test, { type TestOptions } from 'node:test'
import { DB_NAME } from '../../../src/local/db'
import { checkStored, missingStackViolations } from '../../../src/local/testing/invariants'
import { createWorld as create, type World } from '../../../src/local/testing/world'

// Session invariants after every test: a file's tests build worlds with
// `createCheckedWorld` and declare them with `checkedTest`, which runs the stored-data checker
// (`checkStored`, with the session invariants of `sessionViolations`) over each world its body
// made when the body ends. A test that builds a state today's writers or a hand-made writer leave
// violating the invariants calls `expectViolations` with them, as patterns: it then fails if they
// change, so a known violation stays exact until a fix removes it. A commit hook adds the world's
// transition rules and, in a checked world, the lock-holder assertion, and the holes the flushers made (`world.holes`).

let worlds: World[] = []
let expected: readonly RegExp[] = []

export const createCheckedWorld = (options: Parameters<typeof create>[0] = {}) => {
    const world = create({ checks: { lock: true }, ...options })
    worlds.push(world)
    return world
}

/** The violations of every world the running test made. */
export const worldViolations = () =>
    worlds.flatMap((world) => [
        ...checkStored(world.memory, world.sessionOptions),
        ...missingStackViolations(world.memory.dump(DB_NAME)),
        ...world.violations,
    ])

/** Declares the violations the running test expects: one pattern each, all of which must occur. */
export const expectViolations = (...patterns: RegExp[]) => {
    expected = patterns
}

export const checkedTest = (name: string, body: () => Promise<void>, options: TestOptions = {}) =>
    test(name, options, async () => {
        worlds = []
        expected = []
        try {
            await body()
            const found = worldViolations()
            const unexpected = found.filter(
                (line) => !expected.some((pattern) => pattern.test(line)),
            )
            assert.deepEqual(unexpected, [], 'stored data breaks an invariant')
            for (const pattern of expected)
                assert.ok(
                    found.some((line) => pattern.test(line)),
                    `the expected violation ${String(pattern)} no longer occurs`,
                )
        } finally {
            worlds = []
            expected = []
        }
    })
