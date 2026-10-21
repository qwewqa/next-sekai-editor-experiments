import { lockLease, type LockLease } from '../../src/local/sessions'

/** A lease over a plain release function, for tests that count or order releases. */
export const leaseOf = (release: () => void, name = 'test'): LockLease =>
    lockLease(name, Promise.resolve(), release)
