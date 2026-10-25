export type AnalyticsTarget = { origin: string; website: string }

export function analyticsFromEnv(
    env?: Record<string, string | undefined>,
    options?: { native?: boolean; perf?: boolean },
): AnalyticsTarget | null

export const SITE_HOSTS: Record<'production' | 'test', string>

export function gateTag(target: AnalyticsTarget, site: 'production' | 'test'): string
