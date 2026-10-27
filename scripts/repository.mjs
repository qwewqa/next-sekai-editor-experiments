import { execFileSync } from 'node:child_process'

export const defaultRepository = 'qwewqa/next-sekai-editor-experiments'

/** `owner/name` from a GitHub https or ssh remote URL, with or without `.git`; else undefined. */
export function parseGithubRemote(url) {
    const match =
        /^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
            String(url).trim(),
        )
    return match ? `${match[1]}/${match[2]}` : undefined
}

const originUrl = (cwd) => {
    try {
        return execFileSync('git', ['remote', 'get-url', 'origin'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
    } catch {
        return undefined
    }
}

/**
 * The repository the source was checked out from: the checkout's `origin` when it is on GitHub,
 * else `GITHUB_REPOSITORY`, else the default. A workflow in another repository that checks this
 * one out still links here.
 */
export function sourceRepository({ cwd = process.cwd(), env = process.env, origin } = {}) {
    const url = origin === undefined ? originUrl(cwd) : origin
    return (
        (url && parseGithubRemote(url)) || (env.GITHUB_REPOSITORY || '').trim() || defaultRepository
    )
}
