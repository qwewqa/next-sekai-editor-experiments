# `.nxsp` v1 fixtures

Written once by `npm run fixtures:v1` (`tests/fixtures-v1/write.fixtures.ts`) from the editor build
`0.5.22+fbabcfff`: the real editor in Chromium on a dev server, driven through the scenario of Part 1
§1.6.11.9. Each file is what that build wrote, and `SHA256SUMS` pins its bytes.

They are frozen when v0.6.0 is tagged and never changed after it. Every later build opens each one
(`tests/zip/nxspV1.test.ts`, `tests/browser/formats/nxspWriteBackV1.spec.ts`,
`tests/local/fixturesV1.test.ts`), and `check.yml` runs the independent checker over them. A gap is
filled by running the writer of the `v0.6.0` tag, never a later build's.

The files, with the steps that made them (A1 to A13, B, D and E are the scenario's steps and
contexts):

| File | Made by | Holds |
| --- | --- | --- |
| `full.nxsp` | B: A6's file, opened in another browser and saved back in place | History over two devices' `save` entries; every entry kind but `init`; a row `kept: false`; one segment copied whole beside the head manifest; a carried `completeFrom`; the head's BGM, cover and preview with their bytes, earlier ones as metadata only; level info with a rating and a tag icon; group and stage folders; dynamic stages; notes at third lanes; elevation; a depth-1 kind node; unknown top-level and `metadata` keys |
| `kept-first.nxsp` | B: the file on its disk replaced by A10's, then Save and the conflict dialog's Replace | `revision.replaces` names the revision the Replace wrote over; the base's `completeFrom` is carried |
| `carried.nxsp` | D: `full.nxsp` opened in a browser without pickers, edited and saved (a download) | The base's `completeFrom`, carried |
| `not-carried.nxsp` | D: a stored chunk only a row of `full.nxsp` needs goes bad, and the next Save finds it | `completeFrom` is its own revision; the damaged row `kept: false` |
| `media-not-held.nxsp` | D: Undo to a state whose BGM, cover and preview this browser does not hold, then Save As… | `bgm`, `metadata.cover` and `metadata.preview` without a file, with `hash`, `size` and `type`; `options.bgm` true |
| `bgm-unticked.nxsp` | D: back at the head, Save As… with BGM unticked | No `bgm` key while the head records a BGM |
| `no-history.nxsp` | A8: a level file opened (chain I), one edit, Save As… with History unticked | No history |
| `no-media.nxsp` | A7: File › New (chain N), one edit, Save As… | History from the new level's `init` (`init`, `edit`, `save`); no BGM, cover or preview in any state |

A file's `project.json` `appVersion` is the build's. Readers never compare it.
