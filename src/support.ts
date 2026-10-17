// The first import of the entry (Part 1 §1.6.10): when the support gate (public/gate.js) found a
// feature missing, it flagged the page and shows its own, so the bundle stops before it mounts.
declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** Set by the support gate in a browser the editor can't run in. */
        nseUnsupported?: boolean
    }
}

if (typeof window !== 'undefined' && window.nseUnsupported)
    throw new Error('This browser is not supported.')

export {}
