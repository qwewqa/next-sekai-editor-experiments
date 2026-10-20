import { isIosDevice, type UaEnv } from './detect'

/**
 * Host apps whose user agent names them (Part 1 §1.6.10). On iOS most of the work is done here,
 * since several hosts now keep `Safari/` in their UA. Pinterest and Snapchat sit outside the group,
 * since neither has a word boundary before it (` [Pinterest/Android]`, `Safari/537.36Snapchat11…`).
 * Discord's mobile in-app view is a Custom Tab or SFSafariViewController with a plain browser UA,
 * so only its own clients match; `Discordbot/` has no slash after the name and is left out.
 * Refresh yearly.
 */
const HOST_TOKENS =
    /\b(?:FBAN\/|FBAV\/|FB_IAB\/|MetaIAB\b|Instagram\b|Barcelona\b|Line\/|MicroMessenger\/|KAKAOTALK\b|musical_ly|BytedanceWebview\/|LinkedInApp\b|QQ\/|Weibo\b|NAVER\(inapp|Zalo android\/|WA4A\/|WAiOS\/|YJApp-|Twitter for iPhone|TwitterAndroid|Reddit\/Version|[Dd]iscord\/\d)|\[Pinterest\/|Snapchat(?:\/|\d)/

/** The objects Telegram's in-app browser injects, which its Android UA does not show. */
export const HOST_GLOBALS = [
    'TelegramWebview',
    'TelegramWebviewProxy',
    'TelegramWebviewProxyProto',
] as const

/**
 * An app's built-in browser, by its user agent and the globals a host injects: best effort, for
 * wording only (Part 1 §1.6.10). A Home Screen web app is never one, whatever its UA.
 */
export const looksLikeInAppBrowser = (env: UaEnv, standalone: boolean, hostGlobals = false) => {
    if (standalone) return false
    if (hostGlobals) return true
    const ua = env.userAgent
    if (HOST_TOKENS.test(ua)) return true
    if (ua.includes('Android') && ua.includes('; wv)')) return true
    // WKWebView's default UA ends at Mobile/…; Safari and every iOS browser add Safari/.
    return isIosDevice(env) && ua.includes('WebKit/') && !ua.includes('Safari/')
}
