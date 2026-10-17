import type { JournalStore } from './types'

/** The error a member gives before the step that builds it. */
export const notYet = (member: string, step: string) =>
    new Error(`${member} is not available before ${step}`)

const throws = (member: string, step: string) => (): never => {
    throw notYet(member, step)
}

/** Named stub until Step 3. */
export const journalStub: JournalStore = {
    keys: throws('platform.journal', 'Step 3'),
    read: throws('platform.journal', 'Step 3'),
    write: throws('platform.journal', 'Step 3'),
    remove: throws('platform.journal', 'Step 3'),
}
