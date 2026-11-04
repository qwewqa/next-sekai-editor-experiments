export const testTitlePrefix: string

export function siteFromEnv(env?: Record<string, string | undefined>): 'production' | 'test'

export function applyTestSite(html: string): string

export function isTestSitePage(html: string): boolean

export const storeSites: Record<'production' | 'test', { prefix: string; days: number }>
