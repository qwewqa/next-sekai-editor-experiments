import { execFileSync } from 'node:child_process'

export const defaultRepository = 'qwewqa/next-sekai-editor-experiments'

const host = String.raw`(?:www\.|ssh\.)?github\.com`
const path = String.raw`([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`
// https://, ssh:// and git:// with optional credentials (ending at the last @) and port.
const urlForm = new RegExp(
    String.raw`^(?:https?|ssh|git)://(?:[^/]*@)?${host}(?::\d+)?/${path}`,
    'i',
)
// user@host:owner/repo
const scpForm = new RegExp(String.raw`^(?:[^@/:]+@)?${host}:${path}`, 'i')

/** `owner/name` from a github.com, www.github.com or ssh.github.com remote, else undefined. */
export function parseGithubRemote(url) {
    const remote = String(url).trim()
    const match = urlForm.exec(remote) ?? scpForm.exec(remote)
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
