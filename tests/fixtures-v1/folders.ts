import { join, resolve } from 'node:path'

// The folders the readers open: the repository's, or `NSE_FIXTURES_IN=<dir>` (a `<dir>/nxsp-v1` and
// a `<dir>/web-storage-v1`, such as a dry run of the writer wrote) to try the readers on a new set.
const root = resolve(import.meta.dirname, '../..')
const input = process.env.NSE_FIXTURES_IN

export const nxspFolder = input
    ? resolve(input, 'nxsp-v1')
    : join(root, 'tests/native/fixtures/nxsp-v1')
export const webFolder = input
    ? resolve(input, 'web-storage-v1')
    : join(root, 'tests/fixtures/web-storage-v1')
