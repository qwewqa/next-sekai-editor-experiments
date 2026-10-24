# UI design and review checklist

Questions to ask when you build or review UI. They come from defects that shipped or nearly shipped in the History redesign and the colour migration. Read it with [design-language.md](design-language.md) (how the UI is built) and [color-system.md](color-system.md) (colour roles and control recipes).

**How to use and maintain it:**
- These are principles with their reasons, not hard rules. Apply judgement. When one does not fit a case, depart from it and say why in the review.
- The exceptions are the invariants that protect users' work. A notice that is not true, or a path that can lose data, is a defect whatever the design says.
- Add an item only for an issue that recurred or was costly. Give the reason and one short example.
- Generalize before you add. If a new defect is another case of an existing item, extend the example instead.
- Rewrite or remove items that stop matching the product. Keep it short.

## Composition
- **Balanced faces.** A hover, press or focus fill should look centred on what it highlights. Fills that include empty slots or uneven padding read as lopsided. (The History Up and Down arrows.)
- **Proximity carries meaning.** Things that belong together sit closer to each other than to their neighbours. Check with realistic short and long content. (A trailing chevron read as a third arrow.)
- **Whitespace should have a reason:** a column shared with other rows, or room that matches its siblings. An empty area that appears in only one kind of row usually signals a layout problem. (The expanded-group step count.)
- **Lists are one grid.** Decide the columns first (leading mark, text edge, meta), then place every row kind in them. Patching row kinds one at a time drifts. (Expanded History groups.)
- **Scope a mode rule to the row kind it is for.** A rule for two-line rows written on a class every row shares also catches the odd row out. (The Now row sat 1 px off.)
- **A mark per row should be able to differ per row.** Before repeating a glyph on every row, check that it can vary. (Every group member repeated the parent's kind glyph.)
- **Each hierarchy cue should earn its place.** Indentation, guide lines, glyph size and weight work best when each says something the others do not. (Group membership layout.)
- **Look at the whole group, not only the numbers.** Column and centre measurements can all pass while the composition feels wrong. Also look for:
  - empty cells in a column that is otherwise full;
  - near-misses, where things meant to differ sit only a few px apart;
  - whether the heaviest mark is the most informative one.
- **Measure every form a face takes** (label, icon, compact). (The back chevron was 0.7 px off its circle in the icon form only.)

## States
- **Think per interactive element:** rest, hover, press, focus, open or on, and disabled, plus loading and empty where they exist. Families of surfaces hide gaps. (The Details pill and Go To.)
- **On and off should be readable without hover,** and preferably not by colour alone. Press feedback should not be mistaken for an on state.
- **Primary, neutral and destructive actions should be distinguishable** at a glance in both themes.
- **Classify state by behaviour, not by name or look.** Anything held under a finger, key or drag is a press. (The held transport step, the resize line.)

## Colour and focus
- **Roles that must differ should differ in lightness, not hue alone.** Check fill against fill, also under colour-vision deficiency, and list every pair including transient states. (The dark primary against the mint; a light press against the mint.)
- **A focus ring should contrast with both the face and what surrounds it.** (A white ring on an ink pill vanished against a light modal.)
- **Press should differ from hover as clearly as hover differs from rest,** on each surface it sits on, and it should strengthen the ink so it never looks disabled. (Press equalled hover on light bands.)
- **Let contrast choose a direction.** The light chrome is mid-tone, so "lighter on press" can dim white ink. Check colour on the dark chrome in both themes.
- **Before styling from an attribute, list every current use of it and read what each binding means,** then make the style opt-in. (`aria-pressed` on checked manager rows and on toolbar values.)
- **A token retune lands with all of its consumers.** (`selected` at 40 % in `ManagerRow`.)
- **Check a recipe's premise before applying it.** A recipe built for a transparent ghost on a band does not fit a button that is itself the band's fill. A `currentColor` ring does not fit an element that hides its own text.
- **When you add a global rule, search for code that suppresses or overrides it** (a leftover `outline-none`), and run the change through its own guard.
- **Validate a guard on today's tree:** it should fail for every inventoried case. Test the end state of a transition too, such as "no legacy lists left".

## Layout, content and devices
- **Hidden content still takes space.** Opacity, visibility and a delayed animation keep an element in flow. A "Loading" line meant to appear only after a delay opened a 32 px gap under the chosen row for the whole load. Delay by not rendering: gate the element on a timer so it takes no space until it is shown. For any transient element, assert in a browser spec that the neighbouring boxes stay put on every frame, not only that the element appears.
- **Prefer stable geometry.** Controls should not jump when only the content changes. Size a fit from the widest form, not from the live value.
- **Measure what is bounded.** A line whose form is a number and a unit has a measurable widest form, so it is not free text. Size the fit for its usual widest form (for example a 3-digit count) in the longest locale, through the producer's own formatting. (The French "Modifications : 160 n…".)
- **Size fits from every content the producer can return,** enumerated from the function that produces it, not read off the template. (The capsule missed "Settings changed".) A fit that hides or shrinks controls must also include the content it is making room for.
- **Never cut a whole unit in half.** A count, delta or time shows whole or not at all, and the free text gives way first. Check the truncation order in the longest script at every width class, since Latin text may never reach the case. (The Japanese "3‥" group count.)
- **Review the states in each layout the design has:** narrow and wide, dock and dialog, light and dark, and a larger root text size. Not only the headline width. (A focus ring over text in two-line rows; the timeline at 20 px.)
- **Convert every threshold of an element together** when its layout becomes fit-based, or say why one stays fixed. (A leftover pixel breakpoint truncated the date.)
- **Decide what gives way first** when space runs out. Usually the label of the main action survives longest. Remember that touch has no tooltips.
- **Measure when the element mounts, then observe.** A size that starts at an impossible value until an observer fires renders one wrong frame. (The manager list laid out as narrow at width 0.)
- **Leave ring room with the outline offset,** not margins, and check `scrollWidth` against `clientWidth` afterwards.

## Data, feedback and truth
- **A notice must be true when it is shown.** When a call can complete later, return how it ended (landed, cancelled, netted to nothing, failed), not only that it was accepted, and notify on the outcome. A queued Undo said "Undid" before the chart changed, and a failed read said nothing. Test every outcome, including the failure.
- **A view that merges two sources must not drop what it showed.** If one source forgets (a flush that clears its pending list) and the other catches up later, keep what was shown until the second has it. The Timeline lost rows for about a second after a Restore. Test the transient state by sampling frames, not by polling the final list.
- **A merge by overlap must survive a larger update than one overlap window.** A burst of entries replaced the loaded run and the reader's place. Read until the runs join instead of replacing, and bound it.
- **A new state flag needs its consumer in the same change,** and a test of the user-visible effect, such as the computed cursor, not the flag.
- **Apply a safety rule to every component that shares the risk.** (`ConfirmModal` lacked `ChoiceModal`'s 300 ms guard.) A light dismiss should check where the press began and where it ended, so a drag that ends on the backdrop does not discard input.
- **Check that a mechanism works in every build context the code uses:** template, global CSS, scoped style block, landing build. (Tailwind 3 cannot `@apply` global classes inside Vue `<style>` blocks, so the recipes are a plugin.)

## Rules, precedents and records
- **Borrow a precedent's relations, not its numbers,** and check its premise first. (A press style copied from rows whose leading icon was a separate button; the dock's coordinates onto a row whose title selects instead of toggling.)
- **Verify claims about past decisions** against the primary record before letting them constrain a design. (A misremembered "accepted 16 px".)
- **After a revision, grep for the old wording** of every changed claim, in headers and summaries too. When a decision changes, revisit the rules that depended on it.
- **Before you give someone a command or value to use, run it where they will use it.**

## Migrations
- **Split by what renders together,** not only by file. A change should take the shared shells and same-role siblings visible in the views it changes. Otherwise log the interim mix as accepted.
- **Promote repeated patterns to shared recipes.** A second local variant of the same control is a signal to add a recipe. (Selectable rows.)
- **Rebase onto the latest main before matching siblings,** and match the recipes merged siblings chose for the same control type.
- **Pick the tests to run by consumer search:** grep the specs for the changed strings, selectors and DOM regions, and update all consumers of a shared component together.

## Tests and evidence
- **Tests wait on observable, durable state,** not fixed sleeps or transient queues. Wait on a lock query, a new session's sequence number, the focus target, or the canvas size, not on "the dialog is probably open".
- **Check that the server serves what you think it does** before capturing. Fetch the served CSS and look for a recently added rule. Long-lived dev servers can be stale.
- **Make sure the prototype matches the spec** before anyone judges it, ideally by generating it from the spec. (Captures showed 12 px chevrons; the spec said 16 px.)
- **Cover the realistic content variants and states,** not just the default, in the longest locale.
- **Exercise real input.** Capture press, hover and focus the way a user produces them (a real pointer down, real keyboard focus), not by forcing pseudo-classes. Forced states skip parent and sibling rules and the hover and press ordering.
- **Suspect identical state captures.** If rest, hover and press images are byte-identical, the locator probably missed the element.
- **Use both numbers and eyes.** Measurements show alignment; close-up images show whether it looks right.
- **Experiment in a worktree,** not on a checkout that a live server is serving.

## Browser floor
- **Check selectors against the build target** (set in the Vite configuration; today Chrome 106, Edge 106, Firefox 105, Safari 16 and iOS 16). An unsupported selector, such as `:has()` before Firefox 121, invalidates the whole rule it sits in, including its selector list.

## Scope
- **Follow standard best practice** where it is natural and cheap: contrast in both themes, semantic colour roles and visible keyboard focus.
- **Niche modes** such as forced colours get basic function, not polish.
