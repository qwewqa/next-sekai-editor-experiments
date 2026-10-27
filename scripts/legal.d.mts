export type LegalPage = 'privacy' | 'terms'

export const LEGAL_PAGES: Record<LegalPage, string>

export function pageRevision(html: string, file: string): number

export function legalPages(root: string, mode: string): Partial<Record<LegalPage, number>>
