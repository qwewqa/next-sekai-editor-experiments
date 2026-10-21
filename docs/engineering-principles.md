# Engineering principles

Rules that past defects taught. Each has the rule, the reason and one real case. Use them when you write and when you review code or tests.

Like the other pages, these are principles with reasons. Depart from one when a case needs it, and say why in the change.

## 1. A default is for a known absence, never for an unknown value

**Rule.** Use a default when the absence has a defined meaning: the format's default, the product's default, a genuinely empty thing, a first use, or the safe side. When the true value exists but is not known, represent it as absent and show it as unknown, drop its clause, or fall to the safe side. Never fill in a plausible value.

**Why.** A plausible value reads as a fact, and a stored one is never questioned again.

**Example.** A History entry whose count could not be read was stored with `noteCount: 0`, which gave its neighbours false deltas such as +1,200. The count is now optional and stays unknown in the row and in the file, and a row with an unknown count shows no delta (`src/editor/history/rows.ts`). The same rule for the file on disk in the Save conflict dialog: `DiskVersion.notes` is absent when the file has no summary (`src/editor/save/dialogs.ts`), and a Save total over a part of unknown size is unknown, not final (`src/editor/save/total.ts`).

## 2. One fact, one place

**Rule.** A fact has one source. State that mirrors another record is updated where the change happens, and a later event is only an idempotent fallback.

**Why.** Two records of one fact disagree for as long as one of them is late.

**Example.** The modal stack was updated from a dialog's `close` event, a task after the dialog closed, so a key pressed just after Escape was refused and an Undo could be dropped. It is now updated where Escape cancels, and `close` only repeats it. See `src/modals/ModalManager.vue` and `tests/browser/modalEscapeKeys.spec.ts`. The same shape: every Timeline divider named the wrong time after a `.nxsp` open because it read a side lookup (`entry.from`) when the entry's own record held the fact (`src/editor/history/rowText.ts`, `dividerText`); and a Save cut that counted rows by a different rule than the file did.

## 3. Module state has one owner

**Rule.** Module-level state that more than one consumer uses is reference-counted or owned by an explicit instance. The last consumer to leave stops shared work, and a new consumer joins work in progress.

**Why.** Code written for one consumer stops or restarts the work of another when a second one appears.

**Example.** Every mounted Timeline called `followEntries`, but the Edits Here scan state is module-wide, so closing the History dialog stopped the docked panel's scan. See `src/editor/history/source.ts`. The same class: Export's re-entry guard that did not exist during its first `await`, and notice holds released only by the event that placed them (`src/editor/NoticeCard.vue`).

## 4. A failure is not an empty result

**Rule.** A read that failed is reported as failed. It is never returned or shown as an empty list, a zero or a "no".

**Why.** "None found" and "could not look" call for different action, and a user acting on the wrong one loses work.

**Example.** A failed Edits Here scan read as "No edits here", and a recovery listing that failed read as "nothing to recover". A search that can fail has a third state beside found and nothing, with a retry. A `.catch(() => [])` needs a reason in a comment. Storage reads whose empty answer a caller acts on go through the `storedRead` gate (`src/local/storedRead.ts`), which returns the value or the failure and never rejects; `local/stored-reads` keeps those reads there. Each caller writes its failed case; a wrapper over such a read passes the failure on and never decides it for its callers.

## 5. Tests prove what they claim

**Rule.** A regression test fails without its fix; run it once against the unfixed code and say so. A fake behaves like the real code on every path a test relies on; where a test depends on the behaviour of storage or saving code that runs in Node, it uses the real code in preference to a fake. An assertion on an animated property reads it once two consecutive reads agree, or with transitions disabled. An ordering bug is tested with the order fixed, not by repeating runs under load. Wait for a signal, never for a length of time.

**Why.** A test that cannot fail, or that fails one run in six, is read as noise and then ignored.

**Example.** `historyThemes.spec.ts` X-11 read a `::before` box-shadow once while the element animated it and failed about one run in six. The Escape fix is covered by a keydown that holds the main thread so the next keys queue before the `close` task (`tests/browser/modalEscapeKeys.spec.ts`). A fake clock that jumped past a real storage call's watchdog made the History time specs fail at 8 workers (4 of 24 runs before the fix, 0 of 80 after); the fix drains the worker before such a jump. B0's fake storage worker kept a binding the real unlink drops, so a data-loss cell was green on code that loses the file; the matrix now runs the real record and handle handlers (seven worker methods); its flusher, build, size and session reads and dialogs are still fakes.

## 6. Browser specs find elements through shared helpers

**Rule.** A browser spec finds rows, dialogs and other regions through the helpers shared for that region, scoped to it. It does not match text ad hoc. A change to a component's DOM runs that component's specs before it merges, however small it looks.

**Why.** One copy of a locator breaks as one set; many copies break one by one, on main.

**Example.** Wrapping a word of the Timeline's text in a `lang` span broke 21 History specs on main, because their locators matched the Now row's text. The shared History row helper is `row` in `tests/browser/historyJourney.ts`: it matches a row by its title only, so the Now row never matches.

## 7. Lines are true

**Rule.** User-facing text states only what is known. Where completeness, or whether something changed, cannot be proved, the text says so, or leaves the clause out.

**Why.** A line that is not true costs more trust than one that says what is unknown. The owner, 2026-10-20: “In a can’t prove situation, let’s word it to state the uncertainty.”

**Example.** The Save conflict dialog said the file on disk had "0 notes" when it had no summary. It now has a line without the note count (`describe` in `src/editor/save/dialogs.ts`). A group count that may be incomplete reads "10+ steps" only while the scan can still find more. Wording stays as in `src/i18n/en/index.json`.

## 8. No compatibility code for builds that never shipped

**Rule.** Until Stage 1 ships, formats, codecs and the IndexedDB schema change in place at their current version. Do not add migrations, repairs or version bumps for data from a build that was never released. Before code reads, repairs or migrates stored data, name the build that wrote it and check that it shipped; if it did not, clear the profile.

**Why.** There is no user whose data it would protect, and every rule it adds must be kept forever once it ships. The owner, 2026-10-20: “We should not be adding cruft already to handle backwards compatibility between versions that have only been used a few seconds for testing.”

**Example.** Database versions 2 and 3, `createMissingStores` and a dump-seeder repair existed only for test builds, and `MANIFEST_VERSION`, `SESSION_V` and `JOURNAL_VERSION` were raised to 2 before any release. All were returned to 1 with the rules that told the versions apart. See [format-versioning.md](format-versioning.md).

## 9. Protect in proportion

**Rule.** Guard the paths users really take with one simple, structural guarantee. A case that needs two independent failures at once, a failure inside a narrow window, or two tabs plus a failure is an accepted residual: state it once, in the spec, and add no code for it unless the fix is trivial. Session History, recoverable through Recent Sessions, is the main safeguard; protection on the file side matters for bytes that are in a file but not in this browser, and `.nxsp` is the source of truth, while `.nsld` is an import source and an Export artifact.

**Why.** Every extra rule is code to keep and a new place for bugs, some of which lose data themselves. The owner, 2026-10-20: “Let’s be careful that we don’t overindex on edge cases”, and “session history will be robust, with recent sessions being a strong safeguard”.

**Example.** The Save picker redesign grew through seven validation rounds, each finding a narrower case; it was cut to one attempt, one queue and one pick session, with the rarer cases listed as residuals. A partly imported `.nsld` written over after a reload, with storage failing as the pick is identified, is accepted: a user editing the chart would notice first, and the file is not the source of truth.

## 10. A test earns its place

**Rule.** Decide whether to write a test before writing it: write it when it would catch a realistic bug in something that matters, then make it well and show it fails without its fix. Keep tests that have value. Understand a failure that repeats; for a flake, find the test, then remove it if it is of little value, fix it if it is useful, or mark it flaky. Delete a test when, revisited, it costs more than it is worth, never to make a failure go away. Build no harness, oracle or load generator unless a realistic bug needs one.

**Why.** Tests serve the product; a test of little value is upkeep without return. The owner, 2026-10-21: “A bad test is worse than no test”, and “what we really should balance is whether we write a test at all (this is the best time to consider whether it’s really worthwhile)”.

**Example.** Reviews stopped running mutation campaigns over whole changes; one targeted mutation still checks a key safety test. The matrix's Export cells waited a fixed 20 ms for a read, which failed under load once the real storage handlers made the read slower; they now wait until the storage door has no call in flight.

## 11. An element earns its place

**Rule.** Lean towards not having UI of dubious usefulness. Every element is code to maintain, and it can cost users real estate, clicks or confusion. Weigh removing it as a real option, before adding it and when revisiting it.

**Why.** The owner, 2026-10-21: “We should lean towards not having things of dubious usefulness. We should never forget that new features and elements are not free. They have a maintained cost. Depending on the nature of the element, it may negatively impact users in some ways. An element might have almost no use to users, but waste real estate. In the end, we’ve wasted effort, taken on more maintenance burden, and made our users worse off.”

**Example.** The Groups and Stages managers had a collapsed “Current Group” / “Current Stage” row at the top of the list. It only revealed the current item’s path and its shown count, which the status bar’s scope label and the list’s current row already show; it carried a watcher, an injected request, its own keyboard handling and seven translations. It was removed, as were the download note and the “Use only items you are allowed to use.” line the same day.
