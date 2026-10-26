# Design language

How the editor's UI is built: surfaces, shape, size, spacing, type, the History surfaces, and waits and feedback. Use it when you add or change UI, so new work looks like it belongs. Colour roles and control recipes are in [color-system.md](color-system.md). The questions to ask in review are in [ui-review-checklist.md](ui-review-checklist.md).

- **Principles, not laws.** Each rule has a reason. When a case does not fit, depart from it and say why in the change. The rules with the least room to bend are about data safety: guard the user’s work, and never show a notice that is not true ([engineering-principles.md](engineering-principles.md), principles 7 and 9).
- **The code is the record.** Paths are relative to the repository root. Pixel values assume the 16 px root font size set in `src/index.css`. Surfaces that mirror sizes in script follow a changed root size (`src/editor/useRootFontSize.ts`).
- **Keep it true.** Check a claim against the code before relying on it, and fix the page in the same change that makes it false.

---

## 1. Surfaces

Colours are RGB-channel custom properties (`src/themes.css`) exposed to Tailwind through `tailwind.colors.js`, so opacity modifiers work. UI code names a role (`bg-modal`, `text-fg`), never a palette colour. Chart content is the exception ([color-system.md](color-system.md) section 10). Light / dark values of the surface stack:

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

**Minimap** (`src/editor/minimap/Minimap.vue`). A strip docked right after the chart pane in the editor row. The user sets its width by dragging its left edge (`ResizeHandle`, with the keys, Escape and reset of the other dividers): the `minimapWidth` setting, 40 px by default, 24 to 160 px and at most a quarter of the workspace (`minimapWidth` in `src/editor/workspace/index.ts`). It is on by default from a 1000 px workspace, and the side docks' default sizes leave its room at the current width, so turning it on or resizing it moves no panel.
- *Surface:* `bg-bg` with the dark chrome edge on its left (`shadow-[inset_1px_0_0_rgb(255_255_255/0.1)]`). No ring and no shadow.
- *Content:* the chart's own artwork and connector colours, the same in both themes (color-system.md section 10).
- *Box and cursor:* the box is the part of the chart in view: a 2 px `border-white/85` line inside a 1 px `rgb(0 0 0 / 0.6)` ring (a box-shadow) and a `bg-white/[0.16]` fill, so it reads over light and dark notes. It is square, at least 8 px tall, starts 6 px from the left so it stays right of the change ticks' column (the annotation canvas sits above it), and has a `CanvasText` border in forced colours. The cursor is a 1 px `bg-white` line, as the chart's cursor is white. Past the last note both stay pinned at the strip's top, so an *edge mark* says so: an 11 by 6 px white chevron pointing up (`stroke-width 1.5`, `CanvasText` in forced colours), centred right of the tick column, at the top edge. It shows while the cursor or the top of the view is past the range end, and has no animation. The overlay writes a style only when its value changed, with rows rounded to device pixels.
- *Pointer:* `cursor-pointer` on the strip, `cursor-grab` on the box and `cursor-grabbing` while it is held. No hover state and no focus state: the strip is `aria-hidden`, a pointer shortcut whose keyboard equivalents are Jump to Start and End and the Page Up and Down scrolls.
- *Peek:* the mint ring stays on the chart pane (`PeekBar.vue`); the strip adds none of its own.
- *Change ticks:* while the chart marks a peeked step’s changes, `CHANGE_COLOR` ticks at the strip’s left edge, one per run of nearby places, 5 px wide and at least 3 px tall; they cover the 4 px tick column and 1 px of the lane margin. With at most 24 runs, each run shorter than 8 px also gets a 1 device px hairline across the strip in `CHANGE_COLOR` at 45% opacity, drawn under the ticks, so a lone change reads against the notes; long stretches (a select-all move) and busy columns get ticks only. The content takes an inline `opacity: 0.45` (so the compositor does it) while the chart dims, and the annotation canvas is not dimmed, so the marks stay full strength; there are no ticks during the read hold.

**Autoscroll marker** (`src/editor/AutoscrollMarker.vue`). A 32 px circle at the point of a middle press, with filled carets for the axes that scroll (up and down, plus left and right when sideways scrolling is possible) and a centre dot. It is not a control, so it takes the menu surface, not the raised-button face: `bg-popup shadow-md outline outline-1 ring-1` with the menu edge tokens. The floating-card surface (`bg-modal`) nearly vanishes against the chart in dark at this size. It is `fixed`, teleported to `body` so a press near a pane edge or a dock is not clipped, `pointer-events-none` and `aria-hidden`, and it has no animation or hover. The glyphs are `currentColor` fills, as chrome glyphs are (section 3), so forced colours keep them. While it shows, one cursor applies to the whole window through `html[data-autoscroll]` (`ns-resize`, or `all-scroll` with sideways scrolling), as the browsers’ own autoscroll does.

## 2. Shape

Shape says what a thing is, and corners that nest should share a centre.

- **`rounded-full`** is the default for anything you press or type into: buttons, fields, list rows, tab pills, segments, chips and strips.
- **`rounded-xl`** (12 px) is for dialogs, floating cards and multi-line selectable rows in dialogs (`.row-select` in `SaveDialog.vue` and the Preview Assets rows), where a pill would over-round a tall row.
- **`rounded-lg`** (8 px) is for menus, small thumbnails and the Properties subsection toggle. **`rounded`** (4 px) is for menu items and rail tabs, the rows inside a rectangular container.
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
- **24 px (`size-6`):** faces inside the 32 px change capsule.
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
- **Secondary text floor:** `text-fg/80` on a light modal is 4.69:1, the lowest alpha that passes 4.5:1 there. `fg/75` is 4.16, `fg/70` is 3.70 and a 60 % fade is 2.96, so `fg/70` is for glyphs and disabled states only. On `header` only full `fg` passes (4.97:1; `fg/80` is 3.44), so meta text on a band is full ink (`ManagerRow.vue` forces it). `opacity-75` fails the same way (4.16:1), so use `text-fg/80`. On the status bar, text stays `white/80` (4.82:1 on the light chrome) and is not dimmed further. Dark has more room (`fg/70` is 5.6:1 on its modal), so judge light first.
- Muted text is not the same as unavailable: an unavailable History row fades its marks and text but keeps the reason at `fg/80` ([section 8](#8-the-history-surfaces)).

## 7. Responsive

- One viewport breakpoint, 640 px (`sm`). Below it menus become bottom sheets and large dialogs take the full height.
- Inside panels and dialogs the layout follows the container, not the viewport. The container queries are at 13.5, 19, 32 and 35 rem. Some surfaces measure instead. The Properties tabs measure against the sections, and the History peek strip and band pick a form from the widest text they can show.
- Narrow fallbacks keep the main action's label longest: other labels become icon-only with `title` and `aria-label`, then truncate. Touch has no tooltips, so an icon-only control needs a name that is also visible somewhere else.
- A count, delta or time is never cut: it shows whole or not at all, and free text gives way first. Check it in the longest locale.

## 8. The History surfaces

The History surfaces follow the rules above and add a few patterns of their own. These are the ones a later change must keep.

**Peek strip** (`src/editor/history/PeekBar.vue`, fit in `peekFit.ts`)
- A floating strip, 44 px tall: 36 px buttons plus 4 px padding. A mint inset ring round the pane shows that the chart is not live.
- Left to right: the date as a `ghost` button (an info glyph, or a spinner while it loads), `Back to Now` (`btn-secondary`) and `Restore` (`btn-primary`, the commit of the mode).
- Its width is one value per language and width class, measured once from the widest text it can show (`measurePeekWidths`), never from the live date. Stepping between entries therefore cannot resize it, and the change capsule under it never moves.
- As space runs out, `Back to Now` becomes a chevron first, then the date drops to its glyph. `Restore` keeps its whole label until last.
- A session's peek (Recent Sessions) uses the same strip, with the session's name over its time and no change capsule. The name keeps at least 64 px, and a narrow pane stacks the text over the buttons.

**Change capsule** (`ChangeArrows.vue`)
- A second strip under the first, as wide as the strip less 12 px, so its end caps are concentric with the strip's.
- Every face is a 24 px circle or pill 4 px in from the capsule's edge. The faces are the Show Edits toggle (an eye), the summary and two arrows with a count each. The arrow's face is the chevron's circle, so hover, press and focus are drawn centred on the glyph rather than on an empty slot.
- In panes under 320 px, or when the widest state line would not fit, an options button and menu replace the eye and the summary. Disabled arrows dim the chevron and count only, so a focus ring stays strong.
- While a new step's change is read, for up to 250 ms from the first switch, the strip and capsule keep the last read step's date, line, counts, arrows and summary. One swap then follows, and nothing shows blank, dashed or dimmed. After 250 ms they name the new step and show loading. A press meanwhile acts on the new step once it is read (`changes.ts` `awaitingRead`, `pressWhenRead`).
- The first step of a peek has nothing to keep. Its date and change strip stay hidden in place until its change is read or the loading state shows at 250 ms (`firstRead`), and a press waits the same way.
- The fit measures the widest line the producer can return (`changes.ts` `fixedLines` and `countedLines`), in the longest locale.

**History panel band** (`HistoryPanel.vue`) measures its fit in script, and measures again when the locale, the root font size or the fonts change. Its end slot is one grid cell: Go To on the Timeline, and Delete Sessions… on Recent Sessions, as an icon-only trash can with a clock (`ghost ghost-band size-9`), shown only where Settings › Local Data offers it. The cell keeps Go To's width on both tabs in every mode, so the tabs never move. The glyph combines Font Awesome's `trash-can` and `clock`. At 16 px the clock sets it apart from Delete Selection's `trash`.

**Timeline** (`TimelineList.vue`, `rowPresentation.ts`)
- One grid for every row kind: the row pill spans the list less 6 px per side, and a 36 px leading slot holds one mark per row (the Now dot, a kind glyph, a group's disclosure, a member's rail). The text pill follows, so every title starts at the same x and every time ends at the same x.
- Each row kind has a fixed height, so the window needs no measuring. The heights scale with the root font size.
- In a narrow list the count, delta and time move to a caption line under the title. On one line, the title gives way first.
- The current row is the raised pill with a 1 px inset edge (`ring-1 ring-inset ring-fg/25`) in both themes. The edge is there because in light a hovered pill is only 1.05:1 from it, and in dark the shadow does not show.
- A plain row presses its row pill. A group presses its text pill, and its disclosure presses its own circle.
- An unavailable row fades its marks and text to 60 %, while its reason and every focus ring stay full strength.

**Recent Sessions** (`RecentSessionsTab.vue`)
- The Timeline's row grid in its own tab, with the same current row, hover and press. Each row's caption gives the time, then the reason or note count, then the file part last, so a narrow row cuts the file part first.
- At first the list draws a screenful of rows and 50 more. It draws more as it scrolls near the end of what is drawn, and always every row up to the cursor, the selected row, the row of an open menu and the inline Undo rows, with 50 more after them. The keys reach every row, each row has an `aria-rowindex`, and the storage line shows once every row is drawn.
- A ⋯ button at the end opens the row's menu. A row without one keeps the slot, so text edges agree. A damaged or newer row fades its title to 60 % and keeps its caption strong.
- A Delete turns the row in place into "Deleted "X"" with an `Undo` pill, and into the text alone once it can no longer be undone. This row is the only surface for a Delete. A polite live region says each outcome to a screen reader, and an error card appears only for a Delete that did not happen.
- Delete Sessions… is the band's end control on this tab (see the History panel band). When a run has deleted any sessions, the list is read again at once, even while its rows are held still.

**Notice cards** (`src/editor/NoticeCard.vue`, `SeverityIcon.vue`, `notification.ts`)
- The peek strip's surface. Over a blocking dialog a card takes the menus' surface instead (`bg-popup`, the popup outline and ring), so it stands apart from the dialog.
- Contents: an optional severity glyph in the leading slot (color-system.md 5.6), the message, one action and a close button. The message block keeps its one-line width as its basis, so the action and close wrap under it exactly when they cannot share its line.
- The start-up card is the same surface as a column of rows. Its heading row holds the product name and version, and the name gives way first, so the version is never cut. Once any row has a severity, every row reserves the glyph column, so the text edges agree. When the rows are taller than the room, the card scrolls and keeps its close button.
- A touch or pen drag sideways dismisses a card (past 30 % of the width, or a quick flick); a mouse does not swipe. A card stays about 6 s, and holds while hovered or focused. A quick toast (no action, no `card`) keeps its v0.5.22 look and never carries a glyph.

**Not stored** (`src/editor/file/FileChip.vue`)
- The status bar's file chip shows one state at a time, and its dialog lists the others.

**Step Details and Property Changes** (`OperationDetailsContent.vue`, `DetailsHeader.vue`, `PropertyChangesModal.vue`)
- A row exists only when it adds something to the title. A title that says everything leaves the header alone. A block with nothing to show is not drawn, and no heading stands over nothing.
- In a group, a step is a disclosure only when its own record has content. Otherwise it is a plain row with an empty 12 px slot, so labels stay aligned.
- On a phone the dialog stays a centred card that sizes to its content, like every other `BaseModal`.
- Property Changes shows Before and After in two columns. An added or removed entry has one side, so its rows show that value alone, with no empty column.

## 9. Waits and feedback

How the editor shows work in progress, what it shows when something fails or is empty, and where a confirmation puts focus.

### When a wait shows

- **Pick the delay by what the indicator would replace.** An indicator that is the only response to a press, or that fills an empty place, shows at once: the Loading dialog and the placeholder rows. An indicator that would replace something still on screen waits about 150 ms, so a short wait does not flicker. The peek strip's date keeps its info glyph until then (`src/history/peek.ts`), and the busy cursor of a queued Undo starts then (`src/history/stack.ts`).
- **Placeholder rows show at once.** They stand where the rows will be, in the rows' own shape, and have no text, so a short wait shows only a brief change of shape. Without them a list that is loading would look empty for that moment (engineering principle 4). The Timeline's first page and the first read of Recent Sessions are examples.
- **Keep what is still true.** Where the old content is still correct, keep it for up to 250 ms before a loading form replaces it, so most changes are one swap. A glyph beside it can turn into a spinner sooner, at 150 ms. The peek strip and change capsule do this (section 8).
- **A line that moves other content waits 500 ms** when the control the user pressed already shows the press. The chosen Preview Assets row is checked at once, and its "Loading…" line comes only for a slow switch (`AssetSources.vue`). Render the line only once a timer fires, so it takes no space until then (ui-review-checklist.md, "Hidden content still takes space").
- **A dialog whose whole job is the wait opens with the press.** Check File and History, Open… and BGM show the Loading dialog at once, as Open and BGM did in v0.5.22. The dialog is the response to the press, and its title names the work.
- **A dialog in a flow that usually ends without one waits 1 s.** Save, and Export where the browser has a save picker, show Preparing only for a build that takes longer (`PREPARING_MS` in `src/editor/save/imports.ts`). Until then the pressed button is disabled. Export without a picker shows its Ready line in its own dialog instead.
- **Startup has no press.** The startup gate blocks input from the first frame and shows after 150 ms (`src/startup/gate.ts`).
- **No minimum time.** Once the work is done, the result shows at once. The delay already removes most flicker, and a hold would be a second timer on every wait. A dialog held open would also delay the user.
- **A delay is one timer per wait.** Do not read layout or poll on each frame to decide whether to show an indicator.

### How a wait looks

Pick the form by where the wait is. Every form uses the ink (`fg`, or white over the preview) and no accent, so a wait never reads as an on state or a selection.

| Where | Form | Examples |
| --- | --- | --- |
| Rows that are not there yet | Placeholder rows on the rows' grid: `bg-fg/10` bars, `motion-safe:animate-pulse`, `aria-hidden` | Timeline, Recent Sessions, Go To |
| A slot that holds a glyph, or the end of a list | `WaitSpinner`, 16 px | Peek strip date, older Timeline page, Edits Here scan |
| A dialog whose content is the wait, or a step that blocks the dialog | The status text, then `WaitBar` under it: sliding while the total is unknown, filled to the fraction when it is known | Loading dialog, Preparing (not once it says Ready), the Preview Assets chooser's Reading file…, Connecting… and Storing… |
| A line that waits beside content that stays usable | The text alone | Estimating size…, Loading changes…, a Preview Assets row's Loading… |
| The startup gate | `WaitSpinner` at 32 px over the text | Startup gate |
| Over the preview | The v0.5.22 "Loading skin…" overlay | `LevelPreview.vue` |
| A queued key or pointer action with nothing of its own on screen | The `progress` cursor | Undo waiting for its stored step |

- **One spinner and one bar.** `src/editor/workspace/WaitSpinner.vue` and `WaitBar.vue` are the only ones. Do not copy their markup. Copies drifted in size and in how they handled reduced motion.
- **No spinner inside a button.** A button whose work has started is disabled (`opacity-40`), and its dialog or line shows the wait.
- **Show a fraction only when the total is known** and the work usually takes seconds. The bar shows it. The text names the work and does not repeat the percentage. A bar with no fraction yet slides. Check's bar slides while Check waits behind a Save, until each phase's first batch is done, between the phases, and during Check's finish.

### What a wait says

- Name the work with a present participle and the ellipsis character: "Reading file…", "Checking older steps…". Use "Loading…" alone only where its place already says what loads.
- Change the text when the work moves to a new stage, not on every frame.
- No "please wait", and no reassurance.

### Cancel, and the rest of the UI

- **A wait blocks the editor only when the user started it and must see it through.** A file read, a build or a check may be a dialog that blocks the editor, and the dialog can be closed. Any other wait leaves the rest usable and disables only the controls whose press would conflict.
- **Cancel stops the work at its next safe point.** A blocking wait can be cancelled with the dialog's ×, with Escape, and with Cancel when the dialog has a footer. Work that already finished stays, such as a removed session or a written repair, and the outcome says what happened. Once a step has started that cannot be stopped, such as Check's finish, closing the dialog only hides it.
- **A wait that cannot be cancelled has a way out once it is clearly slow.** The startup gate adds Start Blank and Open in Safe Mode after 10 s.
- **A wait in place needs no cancel.** Moving on ends it: another step, another row, closing the panel.
- **A press during a wait is not dropped silently.** It takes effect once the result arrives, as the change arrows do, or it is refused with a reason.

### Motion and accessibility

- **Reduced motion.** `src/index.css` limits transitions to colour and opacity and leaves animations alone. Each animation opts out itself: `motion-safe:` on the motion, and a fade in its place. A spinner or a sliding bar that only stopped would look stuck, so it pulses its opacity. Placeholder rows already look like placeholders when still, so they only drop the pulse (`motion-safe:animate-pulse`).
- **Status text is a live region** (`role="status"`) that is in the page before its text changes, so a screen reader reads each stage. The Loading dialog does this. Preparing's line has none: focus moves to its button, and the line is that button's description. Lines that mount together with their text are announced unreliably: the chooser's Reading file… and Storing… lines and both of its error lines, an asset's Loading line, and the Edits Here scan row. Fix them when the file next changes for another reason.
- **Glyphs, bars and placeholder rows are `aria-hidden`.** A bar that shows a fraction is `role="progressbar"` with its value, labelled by the status text.
- **Focus stays where it was** during a wait in place. A wait dialog follows the dialog rules, and a button that appears when the work is ready takes focus (Preparing).

### Which notice

Section 8 describes the notice card and the quick toast. This part says which one to use.

- **Quick toast:** the outcome of what the user just did, read in passing, and a refusal with a reason the user can see. "Undid …", "Nothing to undo", "Selected notes are already vertical", "Copied the link".
- **Card:** a failure of something the user asked for, such as reading or writing storage or a file, a network request, or loading a chunk. It is a card with the error glyph (color-system.md 5.6), even when the failure is rare. A quick toast fades within a second and is easy to miss. "Could not restore" is an example.
  - The exception is a button pressed on a card. Its outcome is a quick toast, so the card the user is acting on stays. Copy Link on the startup card does this ("Could not copy the link").
- **Inline, in a dialog:**
  - A problem with what the user typed is red text under the field (`text-sm text-danger`, `role="alert"`), with `aria-invalid` on the field. Save and Export do this.
  - The outcome of an action inside a dialog, such as a file that could not be read, is a `text-sm` line in ink with a `SeverityIcon` in its leading slot, in a live region. The From a Server error in the Preview Assets chooser does this, in a region that stays mounted.

### Status glyphs

- `SeverityIcon.vue` is the one warning, error and info glyph, at every size. color-system.md 5.6 says which severity fits. Local copies drew three different triangles, one of them in the text colour.

### Empty lists

- **Empty is not failed and not loading.** A list that can be empty has its own line for it, apart from its failure line (with Try Again) and its loading form (engineering principle 4). A list that stops short because an older page failed to load ends in the failure line with Try Again, rather than stopping at the last row with no line.
- A fragment names what is missing and has no full stop: "No stored items", "No changes yet". A full sentence has one: "This file has no skins."
- The line is `text-fg/80`: `text-sm` in a list pane, the dialog's body size in a dialog. In a list that fills its pane, centre it in a block of fixed height (Timeline, Recent Sessions). In a dialog, start it at the text column like the lines around it (Preview Assets).

### Confirmations

- An undoable delete confirms with `ConfirmModal`. The red button is the default and has focus: the user already asked, and Undo can take it back. A delete or reset that cannot be undone uses `ChoiceModal` with `cancelIsDefault`, so a stray Enter cancels. Both ignore presses in their first 300 ms. See color-system.md 5.2, 8.2 and 8.3.
- A dialog's title drops its command's ellipsis. The command "Export Level Data…" opens a dialog titled "Export Level Data".

## 10. Principles for new UI

1. **Use the roles.** Theme tokens and the recipes, not palette colours or hand-rolled hover and press states. A retune then lands everywhere, and the guard test can check it. A scrim over the chart or a preview overlay (`bg-black/30`) is geometry rather than a role; chrome that sits over the chart may use white or black ink where the chrome tier says so.
2. **Pick a size from the scale.** 36 px, or 32 px where space is tight, or 28 px inside a recess track. Grow the hit area with `::before` rather than the face. A visible 44 px control is a sign something else is wrong. Only the error fallback button (`rendering/RenderingError.vue`, `min-h-11`) and the toolbar on touch have one.
3. **Shape follows what the thing is,** and nested corners share a centre: container radius = inner radius + inset. Inset controls evenly on every side so a hover fill never touches the container on one axis only.
4. **Size to content, then fit.** A floating strip is as wide as what it must hold, and a fit measures that content from the producer's own forms. Check it in the longest locale and at the narrowest pane.
5. **Reuse the pattern before adding a variant.** A second local copy of a control (a selectable row, a tab strip) is the sign to add or use a shared recipe. The same role looks the same in every dialog that shares a shell.
6. **Align to a grid.** Bands, rows, headers and dividers share columns. Indentation, guide lines, glyph size and weight each say one thing.
7. **Every interactive element has all its states:** rest, hover, press, focus, on and disabled, plus loading and empty where they exist ([section 9](#9-waits-and-feedback)).
8. **Secondary text stays legible:** no lighter than `fg/80` on a light modal, full `fg` on bands. Disabled may fade.
9. **Reserve space for what may appear.** Content that is hidden but still in flow takes space. Remove an element until it is shown, rather than hiding it, and keep geometry stable while content changes.
10. **Respect the browser floor.** Check selectors and features against the build target before writing CSS. An unsupported selector invalidates its whole rule.
11. **A tool, its shortcut and its command do the same thing.** A toolbar tool, its keyboard shortcut and any menu or list that offers the command all run that one command (`runCommand`), so a user who learns one knows the others. When two behaviours are needed, make two commands. A link in a notice or dialog may go somewhere more specific. Open History in a notice, for example, goes to a History tab.
12. **Keep the v0.5.22 look.** UI that existed in v0.5.22, the quick toast included, keeps its look unless a change sets out to change it and says so. Surfaces added since fit that look and differ only where their job differs, as the notice cards do.
