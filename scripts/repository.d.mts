export const defaultRepository: string

export function parseGithubRemote(url: string): string | undefined

export function sourceRepository(options?: {
    cwd?: string
    env?: Record<string, string | undefined>
    /** The origin URL; omitted, it is read from git. */
    origin?: string
}): string
