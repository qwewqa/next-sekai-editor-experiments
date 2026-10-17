export type Additions = Partial<Record<string, readonly string[]>>

export const webAdditions: Additions
export const nativeAdditions: Additions
export const devAdditions: Additions

export function scriptHashes(scripts: readonly string[]): string[]

export function basePolicy(scripts?: readonly string[]): string
export function webPolicy(scripts?: readonly string[]): string
export function nativePolicy(scripts?: readonly string[]): string
export function devPolicy(scripts?: readonly string[]): string

export function inlineScripts(html: string): string[]
export function pageMetaPolicy(html: string): string | undefined
export function metaIsFirst(html: string): boolean
export function injectPolicy(html: string, makePolicy: (scripts: string[]) => string): string
