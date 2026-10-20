import { readMeta } from '../db'
import type { WorkerContext } from './handlers'

// The storage worker's one method for Copy Diagnostic Info… (Part 1 §1.4.16): the database's
// versions and how many sessions and chains it holds. Counts only, never a name or any content.

export const diagnosticHandlers = (context: WorkerContext) => ({
    diagnostics: () =>
        context.core.read(['sessions', 'chains', 'meta'], async (tx) => ({
            version: context.core.dbVersion,
            format: await readMeta(tx, 'formatVersion'),
            sessions: await tx.count('sessions'),
            chains: await tx.count('chains'),
        })),
})
