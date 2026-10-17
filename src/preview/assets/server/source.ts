import { AssetImportError, type ImportPart } from '../files/errors'
import { LIMITS } from '../files/limits'
import { categoryOf, type ListedItem, type SourcePackage } from '../files/package'
import type { AssetType } from '../types'
import { ServerError, type ServerClient } from './client'

// A server as the package an item is read from: the same checks and the same repack as for a file
// (`checkItem`, `importItem`), with each entry fetched when it is asked for. An SRL's path is the
// absolute address `resolve` made of it. Details the chooser already has seed it.

const decoder = new TextDecoder()

export const createServerSource = (
    client: ServerClient,
    address: string,
    signal?: AbortSignal,
    seed: Iterable<readonly [type: AssetType, name: string, details: Record<string, unknown>]> = [],
): SourcePackage => {
    const details = new Map<string, Promise<Record<string, unknown>>>()
    for (const [type, name, item] of seed)
        details.set(`${categoryOf[type]}/${name}`, Promise.resolve(item))

    const entry: SourcePackage['entry'] = async (path, options) => {
        try {
            return await client.resource(path, options.maxSize, signal)
        } catch (error) {
            if (error instanceof ServerError) {
                if (error.code === 'notFound') return
                if (error.code === 'tooBig')
                    throw new AssetImportError('tooBig', {
                        type: options.type,
                        part: options.part,
                        limit: options.maxSize,
                    })
            }
            throw error
        }
    }

    const json = async (path: string, type: AssetType, part: ImportPart) => {
        const bytes = await entry(path, { type, part, maxSize: LIMITS.json })
        if (!bytes) return
        try {
            return JSON.parse(decoder.decode(bytes)) as unknown
        } catch (error) {
            throw new AssetImportError('unreadable', { type, part }, { cause: error })
        }
    }

    return {
        entry,
        json,
        resolve: (srl) => client.resolveUrl(address, srl?.url),
        list: async (type) => {
            const page = await client.list(address, type, {}, signal)
            return page.items.map((item): ListedItem => ({
                name: item.name,
                title: item.title,
                author: item.author,
                thumbnail: item.thumbnail ? { url: item.thumbnail } : undefined,
            }))
        },
        details: async (type, name) => {
            const key = `${categoryOf[type]}/${name}`
            let found = details.get(key)
            if (!found) {
                found = client.details(address, type, name, signal)
                details.set(key, found)
                // A failure is not kept, so a retry asks again.
                void found.catch(() => details.delete(key))
            }
            try {
                return await found
            } catch (error) {
                // An item the server does not have is the package's "no such item".
                if (error instanceof ServerError && error.code === 'notFound') return
                if (error instanceof ServerError && error.code === 'tooBig')
                    throw new AssetImportError('tooBig', {
                        type,
                        part: 'details',
                        limit: LIMITS.json,
                    })
                throw error
            }
        },
    }
}
