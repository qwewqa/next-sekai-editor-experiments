/** Chromium steps a focused number input under the wheel; `userAgentData` is missing off secure origins. */
export const isChromium = (navigator: { userAgent: string }) =>
    'userAgentData' in navigator || /(Chrome|Chromium)\//.test(navigator.userAgent)
