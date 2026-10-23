import { shallowRef } from 'vue'
import { i18n } from '../../i18n'
import type { Mark, MarkDeletedResult, UndoDeletedResult } from '../../local/deletion'
import type { RecentChain } from '../../local/recent'
import { interpolateRaw } from '../../utils/interpolate'

// Delete's UI model (Part 1 §1.4.10.6): the chains this tab marked for Delete and their inline
// Undo rows. Delete only runs from a visible list, so the row carries Undo and what came of it;
// a polite live region in the list announces each outcome. The marks live here in memory only;
// storage keeps the `deleting` mark and the sweep needs nothing from this module. Pure and light,
// so Node tests run it with fakes for the page (`DeleteDeps`); `sessionDeleteLive.ts` wires the
// real ones.

/** One chain this tab marked: its row as it was, and what Undo of it can still do. */
export type DeletedEntry = {
    chain: RecentChain
    /** The name the row showed: it stands in the inline row. */
    name: string
    mark: Mark
    /**
     * `deleted`: Undo is offered. `failed`: Undo did not go through; Try Again undoes the same mark.
     * `lost`: the sweep removed it (or it is gone) before Undo; it can no longer be undone.
     */
    status: 'deleted' | 'failed' | 'lost'
}

/** What the model needs of the page. */
export type DeleteDeps = {
    mark: (chainId: string) => Promise<MarkDeletedResult>
    undo: (marks: Mark[]) => Promise<UndoDeletedResult>
    /** Says a Delete that did not happen (no row stands for it): a card the user can read. */
    report: (message: () => string) => void
    /** Lists read again: a chain was marked, restored or found gone. */
    changed: () => void
    /** A peek of the chain ends before it is marked. */
    endPeek: (chainId: string) => void
}

/** What `remove` did, for the list: `busy` is a second press on a chain being deleted. */
export type RemoveOutcome = 'marked' | 'open' | 'gone' | 'failed' | 'busy'

export const createDeleteModel = (deps: DeleteDeps) => {
    /** Every mark with an inline row. */
    const held = new Map<string, DeletedEntry>()
    const pending = new Set<string>()
    const undoing = new Set<string>()
    let lists = 0

    /** The inline rows, by chain: what the lists draw in place of the chains. */
    const inline = shallowRef<ReadonlyMap<string, DeletedEntry>>(new Map())
    /** The last outcome, for the list's polite live region. */
    const announcement = shallowRef('')

    const publish = () => {
        inline.value = new Map(held)
    }

    /** Marks a chain for Delete. */
    const remove = async (chain: RecentChain, name: string): Promise<RemoveOutcome> => {
        const id = chain.chainId
        if (pending.has(id) || held.has(id)) return 'busy'
        pending.add(id)
        deps.endPeek(id)
        let result: MarkDeletedResult
        try {
            result = await deps.mark(id)
        } catch {
            result = { kind: 'failed' }
        } finally {
            pending.delete(id)
        }
        const { session } = i18n.value
        switch (result.kind) {
            case 'marked':
                held.set(id, { chain, name, mark: result.mark, status: 'deleted' })
                announcement.value = interpolateRaw(session.deleted, name)
                publish()
                deps.changed()
                break
            case 'open':
                deps.report(() => interpolateRaw(session.deleteRefused, name))
                break
            case 'gone':
                // Already gone (another tab deleted it): nothing to say, the list reads again.
                deps.changed()
                break
            case 'failed':
                deps.report(() => interpolateRaw(session.deleteFailed, name))
                break
        }
        return result.kind
    }

    /** Undo of a chain's mark, from its inline row (or Try Again). */
    const undo = async (id: string): Promise<void> => {
        const entry = held.get(id)
        if (!entry || entry.status === 'lost' || undoing.has(id)) return
        undoing.add(id)
        let result: UndoDeletedResult
        try {
            result = await deps.undo([entry.mark])
        } catch {
            result = { kind: 'failed' }
        } finally {
            undoing.delete(id)
        }
        const { session } = i18n.value
        if (result.kind === 'failed') {
            // The mark stays: Try Again undoes the same one.
            held.set(id, { ...entry, status: 'failed' })
            announcement.value = i18n.value.commands.undo.failed
        } else if (result.restored.includes(id)) {
            held.delete(id)
        } else {
            held.set(id, { ...entry, status: 'lost' })
            announcement.value = interpolateRaw(session.undoLost, entry.name)
        }
        publish()
        deps.changed()
    }

    /** A list showing (or gone): the inline rows stand only while one is shown. */
    const listShown = (on: boolean) => {
        lists = Math.max(0, lists + (on ? 1 : -1))
        if (lists === 0 && held.size) {
            held.clear()
            announcement.value = ''
            publish()
        }
    }

    return { inline, announcement, remove, undo, listShown }
}

export type DeleteModel = ReturnType<typeof createDeleteModel>
