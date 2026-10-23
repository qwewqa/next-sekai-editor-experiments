# Design language

How the editor's UI is built: surfaces, shape, size, spacing, type and the shipped History surfaces. Use it when you add or change UI, so new work looks like it belongs. Colour roles and control recipes are in [color-system.md](color-system.md). The questions to ask in review are in [ui-review-checklist.md](ui-review-checklist.md).

- **Principles, not laws.** Each rule has a reason. When a case does not fit, depart from it and say why in the change. The invariants that do not bend are about data safety (never lose work, never show a notice that is not true), and they live in the product specification, not here.
- **The code is the record.** Paths are relative to the repository root. Pixel values assume the 16 px root font size set in `src/index.css`. Surfaces that mirror sizes in script follow a changed root size (`src/editor/useRootFontSize.ts`).
- **Keep it true.** Check a claim against the code before relying on it, and fix the page in the same change that makes it false.

---

## 1. Surfaces

Colours are RGB-channel custom properties (`src/themes.css`) exposed to Tailwind through `tailwind.colors.js`, so opacity modifiers work. UI code names a role (`bg-modal`, `text-fg`), never a palette colour. Chart content is the exception ([color-system.md](color-system.md) section 13). Light / dark values of the surface stack:

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `bg` | 64 68 100 | 35 37 57 | the chart |
| `preview` | 91 92 124 | 41 43 66 | dark chrome: docks, rail, status bar |
| `modal` | 233 235 239 | 46 48 72 | panels, dialogs, floating cards |
| `header` | 188 188 209 | 58 60 92 | bands: panel bands, dialog headers, section headers |
| `button` | 255 255 255 | 72 76 114 | raised controls and the current row pill |
| `popup` | 255 255 255 | 58 61 94 | menus |
| `fg` / `fg-strong` | 68 68 102 / 48 51 77 | 222 222 238 / 240 240 250 | ink, and the stronger ink of a pressed control |

Surfaces step up from the chart: chrome, then panels, then bands, then controls. That order is why a control reads as sitting on whatever it is on. Dark adds 1 px light edges where shadows do not show (`--dock-edge`, `--popup-ring`). The other tokens (accent, primary, press, danger, status, recess) and their values are in [color-system.md](color-system.md) section 3.

**Elevation and edges.** Each tier has a reason to exist, so reuse one before inventing another.
- *Raised control:* `shadow-md` through the `btn` recipe. Hover is a mint glow, never a fill change (`src/controls.css`).
- *Floating surface over the chart:* `bg-modal shadow-xl ring-1 ring-fg/10` (`EditorToolModalHost.vue`, `PreviewSettings.vue`, the transport strip in `PreviewTransport.vue`, the peek strip and notice cards). The ring keeps it apart from the chart in dark, where the shadow does not show.
- *Dialog:* `rounded-xl bg-modal shadow-xl`, backdrop `backdrop:bg-scrim/75` (`src/modals/ModalManager.vue`).
- *Menu:* `.popup-surface` (`src/index.css`): `rounded-lg bg-popup text-sm shadow-xl` with an outline in light and a ring in dark.
- *Sticky band over scrolled content:* `shadow-band`, toggled on only while content is under it (`PropertiesPanel.vue`, `ManagerList.vue`, `TimelineList.vue`).
- *Dividers:* `border-fg/15` for light rules inside a surface, `border-fg/25` between sections of a panel or dialog.
- *Dark chrome edges:* inset box-shadows of `white/0.1` (`PanelRail.vue`) and `--dock-edge` on docks (`WorkspaceDock.vue`), not borders.

**Minimap** (`src/editor/minimap/Minimap.vue`). A strip docked right after the chart pane in the editor row, `MINIMAP_REM` (2.5rem, `src/editor/workspace/index.ts`) wide. It is on by default from a 1000 px workspace, and the side docks' default sizes leave its room, so turning it on moves no panel.
- *Surface:* `bg-bg` with the dark chrome edge on its left (`shadow-[inset_1px_0_0_rgb(255_255_255/0.1)]`). No ring and no shadow.
- *Content:* the chart's own artwork and connector colours, the same in both themes (color-system.md section 13).
- *Box and cursor:* the box is the part of the chart in view, `border border-white/70 bg-white/10`, square, at least 8 px tall, with a `CanvasText` border in forced colours. The cursor is a 1 px `bg-white` line, as the chart's cursor is white.
- *Pointer:* `cursor-pointer` on the strip, `cursor-grab` on the box and `cursor-grabbing` while it is held. No hover state and no focus state: the strip is `aria-hidden`, a pointer shortcut whose keyboard equivalents are Jump to Start and End and the Page Up and Down scrolls.
- *Peek:* the mint ring stays on the chart pane (`PeekBar.vue`); the strip adds none of its own.
- *Change ticks:* while the chart marks a peeked step's changes, `CHANGE_COLOR` ticks in a 3 px column at the strip's left edge, one per place and merged into runs, at least 2 px tall. They never reach the notes. The content takes an inline `opacity: 0.45` (so the compositor does it) while the chart dims, with no ticks during the read hold.

## 2. Shape

Shape says what a thing is, and corners that nest should share a centre.

- **`rounded-full`** is the default for anything you press or type into: buttons, fields, list rows, tab pills, segments, chips and strips.
- **`rounded-xl`** (12 px) is for dialogs, floating cards and multi-line selectable rows in dialogs (`.row-select` in `SaveDialog.vue` and the Preview Assets rows), where a pill would over-round a tall row.
- **`rounded-lg`** (8 px) is for menus, small thumbnails and the Properties subsection toggle. **`rounded`** (4 px) is for menu items and rail tabs, which are rows inside a rectangular container.
- **Concentric.** `ManagerRow.vue` states it: "Rows are pills; every control inside is a pill or circle inset evenly by 2px, so shapes stay concentric." A container pads evenly (`p-0.5` or `p-1`) and the controls fill the rest, so the outer radius is the inner radius plus the inset.
  - The peek strip is a pill, 18 px control radius plus 4 px inset.
  - A notice card keeps that corner at any height, `rounded-[1.375rem]` (22 px), so it is a pill at one line and its corners still wrap the 36 px controls at two. The start-up card's 32 px rows fit the same corner (16 + 2 + 4).
  - A timeline row pill is 20 px and its text pill 18 px, inset 2 px.
- Still present: `rounded-2xl` on the key-binding field button and the asset fallback line, `rounded-md` on one start-up diagnostics block. They predate the rules; do not copy them.

## 3. Size and spacing

Control heights are the same for every pointer, so a layout does not change with the input device. The touch enlargement that remains is on the toolbar and its flyout (`LevelEditorToolbar.vue`, coarse pointer only).

- **36 px (`h-9`, `size-9`):** the standard. Dialog buttons, icon buttons, manager row controls, popup rows (`min-h-9`), tab pills, transport buttons, the notice card and peek strip buttons.
- **32 px (`h-8`, `size-8`):** compact controls where 36 px would crowd: toolbar tools, Elevation editor header buttons and fields, Properties ghost buttons, the History filter banner button, start-up card rows.
- **28 px (`h-7`):** segments inside a 32 px recess track (`ChoiceField.vue`).
- **24 px (`size-6`):** faces inside the change capsule, which is itself 32 px.
- **40 and 48 px** are rows and bands, not controls. A manager row is 36 px controls plus `p-0.5`. Bands are 48 px (`BaseModal` header `h-12`, the Properties tabs, the History panel band). Properties section headers are `h-10`.
- **Hit area beyond the face.** A `::before` with a negative inset grows the target without growing the visual: the toolbar tool (`before:size-[--tool-size]`), the peek strip and capsule buttons (`-inset-1`), manager rows, the transport track. Controls whose faces are small can still be hit by a finger.
- **Rows** sit on a 44 px pitch: a 40 px pill and 4 px between pills.

Spacing:
- `gap-1` (4 px) between rows and between strip buttons;
- `gap-2` (8 px) between footer buttons and between an icon and its label in a strip;
- `gap-3` (12 px) from an icon to its label in menus and between fields;
- `p-4` (16 px) for dialog and panel bodies, `px-1.5` (6 px) for band and list gutters in panels;
- dialogs, menus and sheets keep 8 px from the viewport edge.

Icons are Font Awesome fills (`fill-current`): `size-4` for actions and rows, and the single `workspace/ChevronIcon.vue` at its default `size-3` (12 px) everywhere. A close glyph is `size-4` in a band button and `size-3.5` in a smaller pill or card. Muted glyphs such as chevrons and grips use `text-fg/70`. Stroked SVGs are for pictograms of commands, tools and values, not for chrome glyphs such as the check, info, chevron or arrow. A status glyph (`SeverityIcon.vue`) is a fill too.

## 4. Controls

Colour, elevation, hover, press and focus of every button family come from the recipes in `src/controls.css`, described in [color-system.md](color-system.md) section 6. This section is the geometry that stays at the call site.

- **Raised button** (`btn btn-secondary`, `btn-primary`, `btn-danger`, `btn-danger-quiet`): `h-9 min-w-24 max-w-full truncate rounded-full px-4`, normal weight, 16 px (14 px in a strip). Dialog footers are `flex justify-end gap-2`, the one filled button last and focused (`data-autofocus`, see `ConfirmModal.vue`). Weight stays normal: bold is for titles, band labels, tabs and section headings.
- **Ghost** (`ghost`): no face until pointed at. On a band it is `ghost ghost-band`, on the dark chrome `ghost ghost-chrome`. `BaseModal`'s close is the pattern: `ghost ghost-band size-9 rounded-full`.
- **On/off** (`btn-toggle` with `aria-pressed`): mint and flat when on. The toolbar tool in use and Show Edits are examples.
- **Floating pill with an icon:** `.manager-add` is `btn btn-secondary rounded-full p-0.5 pr-4`, the icon in a 36 px slot.
- **Fields** (`field`): raised like a secondary button, `rounded-full`; `aria-invalid` adds a red ring that is separate from the focus ring.
- **Disabled:** `opacity-40` with no pointer events (the recipes do this), or `aria-disabled` with the same opacity when the control should stay focusable.
- **Hover is pointer-only.** Tailwind is configured with `hoverOnlyWhenSupported` and the recipes sit under `(hover: hover) and (pointer: fine)`, so a tap leaves no hover look behind.
- **Focus** is one rule: a 2 px ring drawn 2 px inside the face in the face's own ink, so the face shows on both sides of it. Faces under 32 px use `focus-out`; rows and menu rows use `focus-edge`. Outlines rest transparent so forced colours can paint them; `controls.css` and `index.css` thicken them to 4 px there. Do not suppress an outline without replacing it.

## 5. Bands, rows and lists

- **Band:** opaque `bg-header`, 48 px, bold 16 px label, `px-1.5`. Its controls sit in the same columns as the list below, so a band and its rows read as one grid. In the manager, the band's `px-1.5 py-1` plus the row's `p-0.5` put the All row's eye at the same x as every entry's.
- **Dialog header:** `h-12 bg-header pl-4 pr-1.5 font-bold`, title `text-lg` (`text-base` in tool modals). The body is `p-4` with `gap-4`, so the title and body text share the 16 px edge. Properties section headers (`h-10 px-4`) over `p-4` bodies do the same.
- **Panel tabs on a band** (Properties, History): `h-9 rounded-full px-3` pills, bold, hover `band-hover`, press `band-press`, the current tab marked by a 4 px `bg-fg rounded-t-full` bar flush with the band's lower edge. The recess track is for modal surfaces, not bands.
- **List rows** (manager): a `rounded-full p-0.5` pill, one line: a 36 px icon button, the name (`h-9 px-2 flex-1`), the meta right-aligned (`text-xs tabular-nums text-fg/80`), a 36 px trailing button. Current is `row-current` (`bg-button shadow-md`), hover is `bg-button/70` (a preview of the current pill), checked rows `row-checked`, a drop target `row-drop`. Members indent the name by `ml-5` (20 px) under the folder chevron with a 2 px guide line, and the trailing columns stay aligned.
- **Selectable rows** (a label holding a radio or checkbox) use `.row-select`: a checked radio row is the raised current row, a checkbox row keeps only its mark. Use it rather than a local variant.
- **Popup rows:** `.popup-item` is `min-h-9 px-3 py-2 gap-3 rounded text-sm`, with a 16 px icon column (an empty `size-4` keeps labels aligned when one row has no icon). Headings are `.popup-heading` (`text-xs font-bold text-fg/80`), separators `.popup-separator`, the scroller `.popup-scroller` (`p-1`). On a phone a menu becomes a sheet with `.popup-sheet` over a `bg-black/30` backdrop that is `sm:hidden`.
- **Segmented control:** a `rounded-full bg-recess p-0.5 shadow-track` track of `segment-choice` labels, each face `segment-face h-7 px-2`. Checked is the raised pill. Size and padding stay at the call site.
- **Chips:** `rounded-full px-2 py-0.5 text-xs` on `fg/8` (`.form-field-mixed-value`, `BaseField.vue`).
- **Floating strip:** `rounded-full bg-modal p-1 gap-1 shadow-xl ring-1 ring-fg/10` with 36 px round buttons, the time `text-xs tabular-nums` (`PreviewTransport.vue`).

**Alignment.** Decide the columns first (leading mark, text edge, meta), then fit every row kind and every label or divider into them. Section labels and dividers start at the text column or at the icon column, consistently.

## 6. Type and contrast

- 16 px for rows, fields, buttons and dialog body; `text-lg` bold for dialog titles; `text-sm` for menus, the rail (`font-medium`), strips, notice cards, History rows and Properties headings (bold); `text-xs` for meta, counts, captions and the status bar (`text-white/80` on the chrome).
- Bold for titles, band labels, tabs and section headings; `font-semibold` for folder names; buttons normal.
- Counts, deltas and times are `tabular-nums`, so a changing number does not move the line.
- **Secondary text floor:** `text-fg/80` on a light modal is 4.69:1, the lowest alpha that passes 4.5:1 there. `fg/75` is 4.16, `fg/70` is 3.70 and a 60 % fade is 2.96, so `fg/70` is for glyphs and disabled states only. On `header` only full `fg` passes (4.97:1; `fg/80` is 3.44), so meta text on a band is full ink (`ManagerRow.vue` forces it). Dark has more room (`fg/70` is 5.6:1 on its modal), so judge light first.
- Muted text is not the same as unavailable: an unavailable History row fades its marks and text but keeps the reason at `fg/80` ([section 8](#8-the-history-surfaces-as-shipped)).

## 7. Responsive

- One viewport breakpoint, 640 px (`sm`). Below it menus become bottom sheets and large dialogs take the full height.
- Inside panels and dialogs the layout follows the container, not the viewport. The container queries are at 13.5, 19, 32 and 35 rem. Some surfaces measure instead: the Properties tabs against sections, and the History peek strip and band, which pick a form from the widest text they can show.
- Narrow fallbacks keep the main action's label longest: other labels become icon-only with `title` and `aria-label`, then truncate. Touch has no tooltips, so an icon-only control needs a name that is also visible somewhere else.
- A count, delta or time is never cut: it shows whole or not at all, and free text gives way first. Check it in the longest locale.

## 8. The History surfaces as shipped

The History redesign is the newest large body of UI; it follows the rules above and adds a few patterns of its own.

**Peek strip** (`src/editor/history/PeekBar.vue`, fit in `peekFit.ts`)
- A floating strip, `rounded-full bg-modal p-1 text-sm shadow-xl ring-1 ring-fg/10`: 36 px buttons plus 4 px padding, 44 px tall, `gap-2`. A mint `ring-2 ring-inset` around the pane shows that the chart is not live.
- Contents, left to right (a step): the date as a `ghost` button (an info glyph, or a spinner while it loads), `Back to Now` (`btn-secondary`) and `Restore` (`btn-primary`, the commit of the mode). Hit areas reach 4 px past each face.
- Its width is one value per language and width class, measured once from the widest text it can show (`measurePeekWidths`), never from the live date. Stepping between entries cannot resize it, so the change capsule under it never moves.
- It is at most 480 px wide. As space runs out `Back to Now` becomes a chevron first, then the date drops to its glyph, and `Restore` keeps its whole label until last. Restore's padding narrows in panes under 340 px, and the strip sits lower (`pt-7`) where the chart's corner time labels would otherwise touch it.

- A session's peek (Recent Sessions) uses the same strip with the session's name over its time (`text-sm` over `text-xs text-fg/80`, the time without seconds, no button and no change capsule), then `Back to Now` and `Restore Session` or `Restore as a Copy`. With no capsule to match it may be up to 560 px wide (`SESSION_STRIP_MAX`). The name keeps at least 64 px; under 420 px the strip stacks into two rows (`rounded-[1.375rem]`), the text over the buttons, as wide as the pane less its gutters.

**Change capsule** (`ChangeArrows.vue`)
- A second strip under the first: `h-8 rounded-full bg-modal p-1 text-xs shadow-md ring-1 ring-fg/10`, as wide as the strip less 12 px, so its end caps are concentric with the strip's.
- Every face is a 24 px circle or pill 4 px in from the capsule's edge: the Show Edits toggle (`ghost btn-toggle`), the summary button (`ghost`, or passive text when nothing can be inspected) and two arrows with a count each. The arrow's face is the chevron's circle, so hover, press and focus are drawn centred on the glyph rather than on an empty slot.
- Compact form: an options button and menu replace the eye and the summary, under 320 px panes or when the widest state line would not fit. Disabled arrows dim the chevron and count only, so a focus ring stays strong.
- While a new step's change is read, for up to 250 ms from the first switch, the strip and capsule keep the last read step's date, line, counts, enabled arrows and summary, so one swap follows and nothing shows blank, dashed or dimmed; after 250 ms they name the new step and show loading. A press meanwhile acts on the new step once it is read (`changes.ts` `awaitingRead`, `pressWhenRead`).
- The first step of a peek has nothing to keep: its date and change strip stay hidden in place until its change is read or the loading state shows at 250 ms (`firstRead`), so nothing blank or dashed is painted, and a press then waits the same way (`awaitingRead`).
- The fit measures the widest line the producer can return (`changes.ts` `fixedLines` and `countedLines`), in the longest locale.

**History panel band** (`HistoryPanel.vue`)
- A 48 px `bg-header` band, `px-1.5 gap-1.5`, with Properties-style tab pills, then `Go To` (`ghost ghost-band h-9 text-sm`) and the close button. The filter banner under it is `h-10 border-b border-fg/15 text-xs` with a `btn-secondary h-8` button.
- The band measures its fit in script and re-measures when the locale, the root font size or fonts change.

**Timeline** (`TimelineList.vue`, `rowPresentation.ts`)
- One grid for every row kind: the row pill spans the list less 6 px per side; a 36 px leading slot holds one mark per row (the Now dot, a kind glyph, a group's disclosure, a member's rail); the text pill follows, so every title starts at the same x and every time ends at the same x.
- Rows have fixed heights per kind so the window needs no measuring: 44 px (40 px pill), 80 px for an unavailable entry with its reason, 28 px headers, 32 px dividers. They scale with the root font size.
- Rows are `text-sm`. From 18 rem wide a row is one line (mark, title, count, delta, time on one centre line, the title giving way); below it the count, delta and time move to a `text-xs text-fg/80` caption line.
- The current row is the raised pill (`bg-button shadow-md`) with a 1 px inset edge (`ring-1 ring-inset ring-fg/25`) in both themes: a hovered pill is only 1.05:1 from it in light, and the shadow does not show in dark. Hover is `bg-button/70`, press `bg-press` sunk. A plain row presses its row pill; a group presses its text pill and its disclosure its own circle. Focus rings the pill at its edge in `fg`.
- Members carry a 2 px `bg-fg/30` rail in their leading slot, from under the parent's disclosure to the end of the run.
- An unavailable row fades its marks and text to 60 % while its reason and every focus ring stay full strength.

**Recent Sessions** (`RecentSessionsTab.vue`)
- The Timeline's row grid in its own tab: 44 px rows (40 px pill), the same raised current row, hover and press, and sticky 28 px day headers (`text-xs font-bold`). Each row is two lines: the name (`text-sm`) with an optional badge (`text-xs`, a 1 px `ring-fg/25` pill, for this tab or another), over a caption (`text-xs text-fg/80`) of the time, then the reason or note count, then the file part last, so a narrow row cuts the file part first.
- A 36 px `ghost` ⋯ button at the end opens the row's menu; a row without one keeps the slot, so text edges agree. A damaged or newer row fades its title to 60 % and keeps its caption strong. The storage line ends the list as a `text-xs text-fg/80` footer.
- A Delete turns the row in place into an inline row: "Deleted "X"" with an `Undo` pill (`btn-secondary h-8`, Try Again after a failed Undo with "Could not undo" as its caption), and the text alone once it can no longer be undone. It is the only surface for a Delete; a polite live region says each outcome to a screen reader, and an error card says only a Delete that did not happen.

**Notice cards** (`src/editor/NoticeCard.vue`, `SeverityIcon.vue`, `notification.ts`)
- The peek strip's surface: `rounded-[1.375rem] bg-modal p-1 text-sm shadow-xl ring-1 ring-fg/10`, up to `min(36rem, 100%)` wide. Over a blocking dialog it takes the menus' surface instead (`over`: `bg-popup`, popup outline and ring) so it separates from the dialog.
- Contents: an optional severity glyph in the leading slot, the message, one `btn-secondary h-9` action and a `ghost size-9` close button. The message block keeps its one-line width as its basis, so the action and close wrap under it exactly when they cannot share its line.
- Severity is a second cue next to the words. Error is a circle with an exclamation mark in `text-danger`, warning a triangle in `text-warning`, info a circle with an `i` in `text-info`. No severity, no glyph: a neutral confirmation or a route back is plain. Choose it by what happened: error when what was asked for did not happen, warning when work is at risk or was affected, info when it is only worth knowing.
- The start-up card is the same surface as a column of rows. A heading row holds the product name and version, with the name giving way first so the version is never cut. Each other row has a message and at most one 32 px action pill. Once any row has a severity, every row reserves the glyph column so the text edges agree. When the rows are taller than the room, the card scrolls and keeps its close button.
- The switch card (Restored "X" with Reopen, plus a BGM line) is that column of rows with no heading: its first row holds the close button beside its action, and the rows below it are divided by the 1 px hairline. A row whose action is done (the BGM attached) goes, and the card with it when nothing else is left (`dropCardAction`).
- A touch or pen drag sideways dismisses it (past 30 % of the width or a quick flick); a mouse does not swipe. A card stays about 6 s and holds while hovered or focused. A quick toast (no action, no `card`) keeps its original look and never carries a glyph.

**Level Info** (`src/editor/commands/levelInfo/LevelInfoModal.vue`, `src/editor/levelInfo/MediaRow.vue`)
- A `BaseModal` form with one label column: the file line (the status label's text) with Check File and History…, the text fields, then the Cover and Preview rows. The cover is a 96 px tile (`rounded-xl bg-button shadow-md`) beside its summary; each media row's actions are `btn-secondary h-9` pills that wrap under the summary. One `btn-primary` Confirm ends it. While peeking every field is read-only.

**Not stored** (`src/editor/file/FileChip.vue`, `chipDialogs.ts`, `src/editor/NotStoredBar.vue`)
- The status bar's file chip: a `ghost` button with a 12 px warning or info glyph and short text, the glyph alone in a compact bar. It shows one state at a time, the others as lines in its dialog; Not stored's dialog gives the cause, a way to get storing going (Try Again, Reload or Local Data, by cause), I Have the File when a download is not confirmed, and Save.
- On iOS and iPadOS, which have no leave prompt, a `bg-header` band above the chart (warning glyph, one line, a Save pill) shows while work is not stored and not in a file.

**Menus and dialogs**
- `GoToPopover`, `GoToList` and `ChangeOptionsMenu` use the shared `.popup-*` classes, the font-awesome check, a reserved icon column, and the phone sheet with its backdrop.
- The details and changes dialogs use `BaseModal` and the secondary recipe for Show More, View Chart and Try Again.

**Step Details and Property Changes** (`OperationDetailsContent.vue`, `DetailsHeader.vue`, `PropertyChangesModal.vue`)
- Both open with `DetailsHeader`: the title (bold 16 px, wraps whole), the meta line (`text-sm tabular-nums text-fg/80`: date and time, then " · not kept" or " · damaged" from the row's flags) and, for Property Changes, an optional summary line. Blocks sit 16 px apart, the body's `gap-4`.
- Step Details is one record table, not a stack of one-row sections: a label column `fit-content(40%)` (`text-sm text-fg/80`) beside the values, a `border-t border-fg/15` hairline above every cell so the rules run unbroken, and fact lines as full-width rows under it. A change reads `before › after` on one line (the 12 px chevron at `fg/70`, with screen-reader words), counts are one phrase per line, and a placeholder (Not set, Varies) is `fg/80`. Below 19 rem of container width the label stacks over its value.
- A row exists only when it adds something to the title. A title that says everything leaves the minimal form: the header alone. A block with nothing to show is not drawn, and no heading stands over nothing.
- A group lists its steps newest first under an `h3` that is the step count. A step is a disclosure only when its own record has content; otherwise it is a plain row with an empty 12 px slot, so labels stay aligned, and a step's own flag follows its label at `fg/80`. An opened step shows its record only, indented to the label.
- On a phone the dialog stays a centred card that sizes to its content, like every other `BaseModal`; it is not a sheet.
- Property Changes keeps two captioned columns (Before, After) for long values. An added or removed entry has one side, so its rows show that value alone under the section's Added or Removed badge, with no empty column. A section about one folder uses the singular label (Group Folder, Stage Folder).

## 9. Principles for new UI

1. **Use the roles.** Theme tokens and the recipes, not palette colours or hand-rolled hover and press states. A retune then lands everywhere, and the guard test can check it. A scrim over the chart or a preview overlay (`bg-black/30`) is geometry rather than a role; chrome that sits over the chart may use white or black ink where the chrome tier says so.
2. **Pick a size from the scale.** 36 px, or 32 px where space is tight, or 28 px inside a recess track. Grow the hit area with `::before` rather than the face. A visible 44 px control is a sign something else is wrong; today only the error fallback button (`rendering/RenderingError.vue`, `min-h-11`) and the toolbar on touch do it.
3. **Shape follows what the thing is,** and nested corners share a centre: container radius = inner radius + inset. Inset controls evenly on every side so a hover fill never touches the container on one axis only.
4. **Size to content, then fit.** A floating strip is as wide as what it must hold, and a fit measures that content from the producer's own forms. Check it in the longest locale and at the narrowest pane.
5. **Reuse the pattern before adding a variant.** A second local copy of a control (a selectable row, a tab strip) is the sign to add or use a shared recipe. The same role looks the same in every dialog that shares a shell.
6. **Align to a grid.** Bands, rows, headers and dividers share columns. Indentation, guide lines, glyph size and weight each say one thing.
7. **Every interactive element has all its states:** rest, hover, press, focus, on and disabled, plus loading and empty where they exist.
8. **Secondary text stays legible:** no lighter than `fg/80` on a light modal, full `fg` on bands. Disabled may fade.
9. **Reserve space for what may appear.** Content that is hidden but still in flow takes space. Remove an element until it is shown, rather than hiding it, and keep geometry stable while content changes.
10. **Respect the browser floor.** Check selectors and features against the build target before writing CSS. An unsupported selector invalidates its whole rule.
