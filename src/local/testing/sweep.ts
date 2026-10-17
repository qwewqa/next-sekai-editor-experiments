import { createWorld, type Tab, type World } from './world'

// The crash-at-every-await sweep (§1.6.1): a scenario runs once whole to count the victim tab's
// await points, then once per point with the victim killed there; recovery runs in a fresh tab,
// and the check asserts the invariants after each.

export type SweepContext = { world: World; victim: Tab; seed: number | undefined }

export type SweepCase = {
    seeds: readonly (number | undefined)[]
    /** Prepares the profile; runs to idle before the victim exists. */
    setup?: (world: World) => Promise<void> | void
    /** Starts the work. The harness waits until nothing is queued, so the victim's promise may never settle. */
    scenario: (context: SweepContext) => Promise<void> | void
    /** What a later load does after the kill (recovery order, replay), in a tab of its own. */
    recover?: (context: SweepContext & { killedAt: number | undefined }) => Promise<void> | void
    check: (context: SweepContext & { killedAt: number | undefined }) => Promise<void> | void
}

export type SweepResult = { seed: number | undefined; points: number }[]

const runOnce = async (
    sweep: SweepCase,
    seed: number | undefined,
    killAt: number | undefined,
): Promise<number> => {
    const world = createWorld({ seed })
    await sweep.setup?.(world)
    await world.idle()
    const victim = world.tab('victim')
    if (killAt !== undefined) world.scheduler.killAt(victim.actor, killAt)
    const context = { world, victim, seed }
    // The scenario's own promise may wait on the victim; the queue draining is what counts.
    let failure: unknown
    void Promise.resolve(sweep.scenario(context)).catch((error: unknown) => {
        failure = error
    })
    await world.idle()
    const points = victim.actor.steps
    if (killAt !== undefined && victim.alive)
        throw new Error(`The victim finished in ${points} steps, before point ${killAt}`)
    if (failure && killAt === undefined) throw failure as Error
    await sweep.recover?.({ ...context, killedAt: killAt })
    await world.idle()
    await sweep.check({ ...context, killedAt: killAt })
    return points
}

/** Runs the scenario whole and killed at each await point, under each seed. */
export const crashSweep = async (sweep: SweepCase): Promise<SweepResult> => {
    const result: SweepResult = []
    for (const seed of sweep.seeds) {
        const points = await runOnce(sweep, seed, undefined)
        for (let point = 0; point < points; point++) await runOnce(sweep, seed, point)
        result.push({ seed, points })
    }
    return result
}
