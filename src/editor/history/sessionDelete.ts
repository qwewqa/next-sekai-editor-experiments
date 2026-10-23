import { shallowRef } from 'vue'
import { i18n } from '../../i18n'
import type { Mark, MarkDeletedResult, UndoDeletedResult } from '../../local/deletion'
import type { RecentChain } from '../../local/recent'
import { interpolateRaw } from '../../utils/interpolate'

// Delete's UI model (Part 1 §1.4.10.6): the chains this tab marked for Delete, the notice that
// offers Undo, and the inline Undo rows. The marks live here in memory only; storage keeps the
// `deleting` mark and the sweep needs nothing from this module. Pure and light, so Node tests run
// it with fakes for the page (`DeleteDeps`); `sessionDeleteLive.ts` wires the real ones.

/** One chain this tab marked: its row as it was, and what Undo of it can still do. */
export type DeletedEntry = {
    chain: RecentChain
    /** The name the row showed: it stands in the notice and the inline row. */
    name: string
    mark: Mark
    /** `lost`: the sweep removed it (or it is gone) before Undo; it can no longer be undone. */
    status: 'deleted' | 'lost'
}

/** What the model needs of the page. */
export type DeleteDeps = {
    mark: (chainId: string) => Promise<MarkDeletedResult>
    undo: (marks: Mark[]) => Promise<UndoDeletedResult>
    /** Shows a card (it replaces the card showing) and returns its id. */
    card: (card: {
        message: () => string
        action?: { label: () => string; run: () => void }
        severity?: 'error'
    }) => number
    /** Whether the card is still the one shown. */
    cardShown: (id: number) => boolean
    closeCard: (id: number) => void
    /** Lists read again: a chain was marked, restored or found gone. */
    changed: () => void
    /** A peek of the chain ends before it is marked. */
    endPeek: (chainId: string) => void
}

/** What `remove` did, for the list: `busy` is a second press on a chain being deleted. */
export type RemoveOutcome = 'marked' | 'open' | 'gone' | 'failed' | 'busy'

export const createDeleteModel = (deps: DeleteDeps) => {
    /** Every mark whose notice or inline row can still be used. */
    const held = new Map<string, DeletedEntry>()
    /** The inline rows: while a list is shown. */
    const inlineIds = new Set<string>()
    /** The marks the delete card holds: its Undo undoes all of them. */
    const cardIds = shallowRef<readonly string[]>([])
    let cardId: number | undefined
    /** Whether the card showing is the delete card (not an outcome card). */
    let cardIsDelete = false
    const pending = new Set<string>()
    const undoing = new Set<string>()
    let lists = 0

    /** The inline rows, by chain: what the lists draw in place of the chains. */
    const inline = shallowRef<ReadonlyMap<string, DeletedEntry>>(new Map())

    const publish = () => {
        // Marks nothing refers to any more are let go.
        for (const id of held.keys())
            if (!inlineIds.has(id) && !cardIds.value.includes(id)) held.delete(id)
        inline.value = new Map(
            [...inlineIds].flatMap((id): [string, DeletedEntry][] => {
                const entry = held.get(id)
                return entry ? [[id, entry]] : []
            }),
        )
    }

    const showing = () => cardId !== undefined && deps.cardShown(cardId)

    const deletedMessage = () => {
        const ids = cardIds.value
        const { session } = i18n.value
        const only = ids.length === 1 ? held.get(ids[0] ?? '') : undefined
        return only
            ? interpolateRaw(session.deleted, only.name)
            : interpolateRaw(session.deletedMany, String(ids.length))
    }

    const outcome = (message: () => string, severity?: 'error') => {
        cardIsDelete = false
        cardIds.value = []
        cardId = deps.card({ message, ...(severity ? { severity } : {}) })
    }

    /** The delete card for the marks it holds: merged into the card showing, which it replaces. */
    const raiseDelete = (id: string) => {
        const merge = showing() && cardIsDelete
        cardIds.value = merge ? [...cardIds.value, id] : [id]
        cardIsDelete = true
        cardId = deps.card({
            message: deletedMessage,
            action: {
                label: () => i18n.value.commands.undo.title,
                run: () => void undo(cardIds.value),
            },
        })
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
                inlineIds.add(id)
                raiseDelete(id)
                publish()
                deps.changed()
                break
            case 'open':
                outcome(() => interpolateRaw(session.deleteRefused, name), 'error')
                break
            case 'gone':
                // Already gone (another tab deleted it): no notice, the list reads again.
                deps.changed()
                break
            case 'failed':
                outcome(() => interpolateRaw(session.deleteFailed, name), 'error')
                break
        }
        return result.kind
    }

    /** Undo of these chains' marks, from the notice or an inline row. */
    const undo = async (ids: readonly string[]): Promise<void> => {
        const entries = ids.flatMap((id) => {
            const entry = held.get(id)
            return entry?.status === 'deleted' && !undoing.has(id) ? [{ id, entry }] : []
        })
        if (!entries.length) return
        for (const { id } of entries) undoing.add(id)
        let result: UndoDeletedResult
        try {
            result = await deps.undo(entries.map(({ entry }) => entry.mark))
        } catch {
            result = { kind: 'failed' }
        } finally {
            for (const { id } of entries) undoing.delete(id)
        }
        const { session, history } = i18n.value
        if (result.kind === 'failed') {
            // The marks stay: Try Again undoes the same ones, and the inline rows keep their Undo.
            cardIsDelete = false
            cardIds.value = []
            cardId = deps.card({
                message: () => session.undoFailed,
                action: {
                    label: () => history.tryAgain,
                    run: () => void undo(entries.map(({ id }) => id)),
                },
                severity: 'error',
            })
            return
        }
        const restored = new Set(result.restored)
        const lost: DeletedEntry[] = []
        for (const { id, entry } of entries) {
            if (restored.has(id)) {
                held.delete(id)
                inlineIds.delete(id)
            } else if (result.lost.includes(id)) {
                const gone: DeletedEntry = { ...entry, status: 'lost' }
                held.set(id, gone)
                lost.push(gone)
            }
        }
        const wasShown = showing() && cardIsDelete
        cardIds.value = cardIds.value.filter((id) => held.get(id)?.status === 'deleted')
        publish()
        deps.changed()
        const [first] = lost
        if (first) {
            const message = () =>
                lost.length === 1
                    ? interpolateRaw(session.undoLost, first.name)
                    : interpolateRaw(session.undoLostMany, String(lost.length))
            outcome(message)
        } else if (wasShown && !cardIds.value.length && cardId !== undefined) {
            // Everything the card offered is back: it has nothing left to say.
            deps.closeCard(cardId)
        }
    }

    /** A list showing (or gone): the inline rows stand only while one is shown. */
    const listShown = (on: boolean) => {
        lists = Math.max(0, lists + (on ? 1 : -1))
        if (lists === 0 && inlineIds.size) {
            inlineIds.clear()
            publish()
        }
    }

    return {
        inline,
        remove,
        undo,
        listShown,
        /** The marks the card shows now, for tests. */
        cardMarks: () => cardIds.value,
    }
}

export type DeleteModel = ReturnType<typeof createDeleteModel>
