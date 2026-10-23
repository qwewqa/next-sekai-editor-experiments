import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// What each context hands the next: files and dumps, kept in a work folder (NSE_FIXTURES_WORK, in
// test-results by default) that the output step reads.

const root = resolve(import.meta.dirname, '../..')

export const workDir = resolve(
    process.env.NSE_FIXTURES_WORK ?? join(root, 'test-results/fixtures-work'),
)

export class Products {
    constructor(private readonly dir = workDir) {
        mkdirSync(dir, { recursive: true })
    }

    put(name: string, bytes: Uint8Array | string) {
        writeFileSync(join(this.dir, name), bytes)
    }

    has(name: string) {
        return existsSync(join(this.dir, name))
    }

    bytes(name: string) {
        return new Uint8Array(readFileSync(join(this.dir, name)))
    }

    text(name: string) {
        return readFileSync(join(this.dir, name), 'utf8')
    }

    json<T = unknown>(name: string) {
        return JSON.parse(this.text(name)) as T
    }

    names() {
        return readdirSync(this.dir)
    }
}
