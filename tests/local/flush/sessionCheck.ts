import assert from 'node:assert/strict'
import test, { type TestOptions } from 'node:test'
import { DB_NAME } from '../../../src/local/db'
import { checkStored, missingStackViolations } from '../../../src/local/testing/invariants'
import { createWorld as create, type World } from '../../../src/local/testing/world'

// Session invariants after every test (architecture review A0): a file's tests build worlds with
// `createCheckedWorld` and declare them with `checkedTest`, which runs the stored-data checker
// (`checkStored`, with the session invariants of `sessionViolations`) over each world its body
// made when the body ends. A test that builds a state today's writers or a hand-made writer leave
// violating the invariants calls `expectViolations` with them, as patterns: it then fails if they
// change, so the evidence the review cites stays exact until the fix removes it. A0+ adds what a
// commit hook sees: the world's transition rules and, in a checked world, the lock-holder
// assertion (I-1), and the holes the flushers made (`world.holes`, R2-2 and R3-7).

let worlds: World[] = []
let expected: readonly RegExp[] = []

/** The known breaches pinned today: each names the increment whose acceptance deletes the pin. */
export type Increment = 'AP' | 'A2'

export const PINS: { pattern: RegExp; clearedBy: Increment; why: string }[] = []

/**
 * A violation today's code is known to make, for `expectViolations`. It names the increment that
 * clears it (AP or A2): that increment's acceptance deletes the pin (design A §7).
 */
export const pin = (pattern: RegExp, clearedBy: Increment, why: string) => {
    PINS.push({ pattern, clearedBy, why })
    return pattern
}

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
