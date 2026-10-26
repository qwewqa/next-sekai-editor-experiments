export function stageDevPreviewAssets(
    root: string,
    env?: NodeJS.ProcessEnv,
    cacheRoot?: string,
): Promise<{ skipped: boolean; failures: string[] }>

export function previewAssetsMode(
    root: string,
    env?: NodeJS.ProcessEnv,
): Promise<{ included: true } | { included: false; reason: string }>
