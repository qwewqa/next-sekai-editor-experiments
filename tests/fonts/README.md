# Test fonts

Selawik 1.01 (Regular, Semibold and Bold), from <https://github.com/microsoft/Selawik>, under the SIL Open Font
License 1.1 (`selawik/OFL.txt`). It is made to match the metrics of Segoe UI, so a layout test sees the same text
widths on every machine, whatever fonts it has.

The fonts are for tests only. They are never bundled, so they are not in `THIRD_PARTY_NOTICES`.

`test-font.css` loads them and sets them as the page's font. The Vite dev server adds it to every page when
`NSE_TEST_FONT=1`, which the `webServer` entry of `playwright.config.ts` sets, so it reaches every page a spec opens,
in any context it creates. Canvas labels read the page's computed font, so they follow. CJK text has no glyphs in
Selawik and falls back to the machine's own fonts, so specs on those languages check fit and overflow, never exact
widths or wrap points. `tests/browser/testEnvironment.spec.ts` checks that the font is the one drawn.
