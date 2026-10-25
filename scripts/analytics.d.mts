export type AnalyticsTarget = { origin: string; website: string }

export function analyticsFromEnv(
    env?: Record<string, string | undefined>,
    options?: { native?: boolean; perf?: boolean },
): AnalyticsTarget | null
