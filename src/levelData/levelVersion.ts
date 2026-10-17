/**
 * The level model's version: it goes up when the editor gains an archetype, a field or a choice
 * value an older parser would drop. The declared table (`known.ts`) tags each with the version
 * that added it, and a test fails when the two disagree.
 */
export const LEVEL_VERSION = 1
