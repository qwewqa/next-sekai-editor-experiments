// The recovery order on start (Part 0 §0.9.8, Part 1 §1.6.11.10): every load runs these steps in
// this order before any session opens: the canary against storage as found, then the journals,
// then the old auto save. A named list with insertion points, so the apps add to it (the origin
// check in place of the canary, start-time triage after all) instead of editing tested code.

export type RecoveryStepName = 'canary' | 'journals' | 'legacyMigration' | (string & {})

export type RecoveryStep<C> = {
    readonly name: RecoveryStepName
    readonly run: (context: C) => Promise<void> | void
}

/** Where `addRecoveryStep` puts a step: after the canary, or after every other step. */
export type RecoveryPoint = 'afterCanary' | 'afterAll'

export class RecoverySteps<C> {
    private readonly steps: RecoveryStep<C>[]
    private readonly afterCanary: RecoveryStep<C>[] = []
    private readonly afterAll: RecoveryStep<C>[] = []

    constructor(steps: readonly RecoveryStep<C>[]) {
        this.steps = [...steps]
    }

    /** Adds a step at an insertion point, after any added there before. */
    addRecoveryStep(step: RecoveryStep<C>, { at }: { at: RecoveryPoint }) {
        if (this.names().includes(step.name)) throw new Error(`A step ${step.name} exists`)
        ;(at === 'afterCanary' ? this.afterCanary : this.afterAll).push(step)
    }

    /** Replaces a named step in place (the apps' canary), keeping its position. */
    replaceStep(name: RecoveryStepName, step: RecoveryStep<C>) {
        for (const list of [this.steps, this.afterCanary, this.afterAll]) {
            const at = list.findIndex((each) => each.name === name)
            if (at === -1) continue
            list[at] = step
            return
        }
        throw new Error(`No step ${name}`)
    }

    /** The steps in the order they run. */
    ordered(): RecoveryStep<C>[] {
        const at = this.steps.findIndex((step) => step.name === 'canary')
        const head = at === -1 ? [] : this.steps.slice(0, at + 1)
        const rest = at === -1 ? this.steps : this.steps.slice(at + 1)
        return [...head, ...this.afterCanary, ...rest, ...this.afterAll]
    }

    names() {
        return this.ordered().map((step) => step.name)
    }

    /** Runs each step in turn; one that throws stops the order, and startup reports it. */
    async run(context: C, skip: (name: RecoveryStepName) => boolean = () => false) {
        for (const step of this.ordered()) if (!skip(step.name)) await step.run(context)
    }
}
