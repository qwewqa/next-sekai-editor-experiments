# Colour system

Final, 2026-10-19. This becomes `editor/docs/color-system.md` (colour package C0, below). It replaces the v3 proposal; the critique (`critique.md`) and the owner's four decisions of 2026-10-19 are applied, and the changes from v3 are listed at the end.

- **Source files.** The values and recipes live in three files that C0 copies verbatim. The prototype compiles exactly these, so the captures cannot drift from them:
  - `color/final/themes.css` → `src/themes.css`
  - `color/final/tailwind.colors.js` → `tailwind.colors.js`
  - `color/final/controls.css` → `src/controls.css`
- **Evidence.** `shots/final/sheets/`: BEFORE (main) beside AFTER, light above dark, desktop and phone. Section 14 lists the sheets to open first.
- **Scope.** UI colour roles. Chart content keeps its own colours (section 13).

---

## 1. In one paragraph

Mint keeps one meaning: **something is on** (a switch, the tool in use, a mode in force, rows checked for an action, and the current marker on the dark chrome). **The primary action is ink:** indigo in light and periwinkle in dark, so action and on differ in lightness as well as hue. **Destructive is red in both themes:** a filled red for the action a destructive dialog exists for, and a quiet red label when it is offered beside a safe default. **Three elevations tell the state:** raised is pressable, flat is on, and sunk is being pressed. **A press is one step beyond hover:** the face takes one tone, the ink strengthens, it sinks, and a raised control keeps its mint glow, so a tap always shows and never looks like on or like disabled. **Focus is one rule:** a 2 px ring drawn 2 px inside the face, in the face's own ink. Warning and info are tokens with their glyphs. The neutrals, the surfaces, the white raised pills, the hover glow and the quick toast keep their v0.5.22 look.

---

## 2. Principles

Each principle gives its reason and its known exceptions. When one does not fit a case, depart from it and say why in review.

1. **Name a role, not a colour.** Components use role tokens (`primary`, `danger-fill`, `press`) through the recipes, never raw palette classes (`amber-300`) or literals in UI chrome.
   - *Reason:* a role can be retuned in one place, and the guard test can check its use.
   - *Exceptions:* chart content (section 13); shadows that are geometry rather than a role, such as the dock edge.

2. **Mint means on.** The tool in use, a switch that is on, Show Edits, Select while selecting, rows checked for an action and the peek ring are mint. The quick notice is mint too, as the brand's one transient voice.
   - *Reason:* it is the app's brand colour, and in v0.5.22 it was every on-state. Giving it one meaning lets a user read it at a glance.
   - *How the rest is shown:* single-select selection (the current row, the selected segment) is elevation, the raised pill. Current markers are mint only on the dark chrome, where mint has contrast (the rail tab bar); on light bands they are ink (the band tab marker, 4.97:1 against mint's 1.85:1). Thin mint marks on light surfaces use `accent-strong`.
   - *Exception:* the hover and press glow is mint. It is a shadow, never a fill, and it lasts only while pointed at or pressed, so it cannot read as on.

3. **Ink is the primary action.** A button is primary when it is the default that Enter presses, or the commit of a mode or form (Restore commits peek mode). A footer has at most one filled button, and it is the one Enter presses.
   - *Reason:* the safe path is the strongest, which serves the data-loss rule. The Enter target is obvious, and the primary cannot be mistaken for an on-state.
   - *Exception:* a destructive ConfirmModal fills its own action red, because that action is the one Enter presses (see 8.2).

4. **Red means destructive or failed. It is told apart by form.**
   - Destructive: a button or menu row naming the action, with a trash icon in menus.
   - Error: a text line with `role="alert"` and its glyph.
   - A destructive choice offered beside a safe default is quiet (a neutral pill with a red label) and fills red only when pressed.
   - *Reason:* both mean harm, so they share a hue; their form keeps them apart. Quiet labels keep a single filled button per footer.

5. **Status hues come with their glyphs.** Warning is amber with a triangle, and info is blue with a circle. There is no success hue (success is the quick notice).
   - *Reason:* amber and red are close for deuteranopia (light ΔE 1); the glyph and the words carry the meaning.
   - *Exception:* the change orange is drawn only on the chart, never in the UI (section 13).

6. **Roles that must differ, differ in lightness, not hue alone.** Check fill against fill, under colour-vision deficiency too, not only text against fill. Section 4.3 is the check.
   - *Reason:* about 1 man in 12 has a red-green deficiency, and a hue-only difference vanishes for him. That is why the v3 dark primary was rejected (deutan ΔE 2.0 from mint), and why the light press face is darker than the mint (deutan ΔE 1.6 at the lighter value).
   - *Exceptions:* pairs that never meet, or that something other than colour separates, are listed with the reason (danger fill against primary fill: one footer never shows both).

7. **Three elevations tell the state.**
   - **Raised** (shadow): pressable at rest.
   - **Flat** (no shadow): on, latched among raised neighbours. This is the tool in use and a raised toggle that is on.
   - **Sunk** (inner shadow): being pressed.
   - *Reason:* this is a non-colour cue for the two states that colour alone separates least. It also matches the existing shapes, so nothing new has to be learned.
   - *Exception:* ghosts have no elevation, so they show state with their tint alone.

8. **Hover is pointer-only and transient.** A raised face glows mint, and red if it is destructive. A face that is on (flat) glows too. A ghost takes one tint step: `fg/10` on a panel or popup, `band-hover` on a band, white/10 on the chrome.
   - *Reason:* this is the v0.5.22 language. On touch nothing depends on hover.
   - *Exception:* a trigger whose menu or popover is open holds its hover look. It opts in with `aria-haspopup` plus `aria-expanded`; a disclosure opts in with `.holds-open`.

9. **Press is one step beyond hover, ink strengthened.**
   - A raised face takes the `press` tone, its ink becomes `fg-strong`, it sinks, and it keeps its glow (see 8.1 for the decision).
   - A filled face steps its own fill.
   - A ghost takes a second tint step, the same size as its first.
   - *Reason:* a press must read as a touch on every surface, never as on or disabled. Disabled fades the ink; press strengthens it, and the glow shows it is live.
   - *Direction:* the step goes the way that keeps the label at 4.5:1. That is usually the same direction as hover and toward the label. The exceptions, each forced by contrast:
     - dark filled faces with dark ink (periwinkle, coral) lighten;
     - on the mid-tone light chrome, a press darkens (`chrome-press`), because a lighter step dims its white ink below 4.5:1.
   - *Classify by behaviour:* anything held under a finger, key or drag is a press, including the held transport step, the flyout row under a press-drag and the resize line being dragged.

10. **Focus is a 2 px ring drawn 2 px inside the face, in the face's own ink.** Face shows on both sides of the ring, so it reads on any fill over any surface.
    - *Reason:* a ring is visible only if it contrasts with what lies on both sides of it. A ring flush with the edge merges with a surround of its own colour: the white ring of an ink pill on a white-ish modal, or the ink ring of a light tool over the ink-coloured chart.
    - *Exceptions:*
      - Faces under 32 px draw it 1 px outside, in the surface's ink (`.focus-out`).
      - Rows and menu rows ring at their edge with `focus-edge` (a 2 px `fg` ring, no offset), because `fg` contrasts with both the row and the surface.
      - Text fields show it on `:focus`, because a caret appears there.

11. **State is never colour alone, where that is natural.**
    - On/off: the knob moves and the field reads Enabled or Disabled. Show Edits swaps the eye for the hidden eye. The tool in use sits flat.
    - Selected: the raised pill, a checkbox or a tab bar.
    - Destructive: the label names the action.
    - Disabled: opacity, never a hue.

12. **Contrast is measured against what lies on both sides, and the chrome is checked on both chromes.** Text and icons on their face need 4.5:1. State indicators and edges that matter need 3:1. The light status bar is mid-tone (L 0.49), not dark.

13. **A real dark theme, tuned, not inverted.**
    - Surfaces stay deep indigo, and body ink (`fg`) is never pure white. The chrome keeps its v0.5.22 white/80 and white.
    - Dark fills carry dark ink (`#232539`): periwinkle, coral, mint.
    - A tune that cannot be seen (ΔE under 2) is not made: dark mint and dark danger text keep their v0.5.22 values.

14. **Style from state opt-in, never from a bare attribute.** A recipe styles `aria-pressed` only on `.btn-toggle`, and the open look only on popup triggers or `.holds-open`.
    - *Reason:* one attribute can mean different things. `aria-pressed` marks a checked Manager row and a toolbar value in use; `aria-expanded` marks folder disclosure. Section 6.3 lists every current use.
    - *Rule:* before styling from an attribute, list its current uses.

15. **A token retune lands with every consumer of that token.** The `selected` retune and the ManagerRow tint therefore ship together in C0.

16. **Keep the feel.** The palette stays seven hues; no surface colour changes; the light `accent`, `danger` and surfaces are byte-identical to v0.5.22.

17. **Forced colours: basic function only** (owner, low priority). The recipes keep the transparent resting outline that high contrast paints as an edge, and thicken focus to 4 px there. No other work.

---

## 3. Tokens

Values are RGB channel triples, as in `src/themes.css`. OKLCH is given as L C h.

These are unchanged from v0.5.22:

- the surfaces and inks: `fg`, `fg-strong`, `bg`, `scrim`, `button`, `header`, `header-hover`, `modal`, `popup`, `popup-hover`, `popup-edge`, `preview`, `knob`, `recess`, `band-hover`, `change`;
- `accent` and `on-accent` (the same in both themes);
- the light `danger` and `on-danger`, and the dark `danger`.

### 3.1 Role tokens

| Role | Token | Light | Dark | Used for |
|---|---|---|---|---|
| On; brand | `accent` | 119 239 220 `#77efdc` (.877 .112 182) | same | Tool in use, switch track on, Show Edits, Select on, snap on, rail marker, peek ring, quick notice |
| Ink on mint | `on-accent` | 48 51 77 `#30334d` | same | Glyphs and text on `accent` / `accent-press`; the switch knob when on |
| On, pressed | `accent-press` *new* | 72 201 182 `#48c9b6` (.760) | same | Pressing something that is on |
| Thin mint marks | `accent-strong` *new* | 20 128 116 `#148074` (.541 .092 183) | 119 239 220 (= accent) | Drop-target ring, current-and-checked ring, any thin mint mark on a light surface |
| Checked rows | `selected` *retuned* | 165 227 214 `#a5e3d6` (.870 .065 180) | 40 85 90 `#28555a` (.420) | Rows checked for an action; the drop-target fill. Full strength, no `/40` |
| Primary | `primary` *new* | 68 68 102 `#444466` (.402 .057 284), = fg | 157 159 214 `#9d9fd6` (.721 .080 283) periwinkle | The one primary button of a dialog, strip or form |
| Ink on primary | `on-primary` *new* | 255 255 255 | 35 37 57 `#232539` | |
| Primary pressed | `primary-press` *new* | 95 95 133 `#5f5f85` (.501) | 183 185 234 `#b7b9ea` (.801) | |
| Raised face pressed | `press` *new* | 193 193 219 `#c1c1db` (.819 .036 286) | 102 105 139 `#66698b` (.531) | Every raised neutral control while pressed or held |
| Ghost pressed | `ghost-press` *new, alpha* | fg / 0.25 | fg / 0.20 | A ghost or menu row while pressed, over any panel or popup |
| Band pressed | `band-press` *new, alpha* | white / 0.8 | white / 0.2 | A ghost on a header band while pressed (`band-hover` is white/0.4 and /0.1) |
| Chrome pressed | `chrome-press` *new, alpha* | black / 0.18 | white / 0.2 | A ghost on the dark chrome while pressed |
| Destructive and error text | `danger` | 185 28 28 `#b91c1c` | 255 184 184 `#ffb8b8` (unchanged) | Quiet destructive labels, destructive menu rows, error lines |
| Destructive fill | `danger-fill` *new* | 185 28 28 | 237 117 110 `#ed756e` (.700 .150 25) coral | The destructive confirm; a pressed quiet destructive; a pressed destructive menu row |
| Ink on destructive fill | `on-danger` *dark retuned* | 255 255 255 | 35 37 57 (was 48 51 77) | |
| Destructive pressed | `danger-press` *new* | 205 72 64 `#cd4840` | 247 149 141 `#f7958d` | |
| Warning | `warning` *new* | 146 91 12 `#925b0c` (.521 .110 68) | 255 218 124 `#ffda7c` (.900 .121 88) | Warning text and glyphs, always with the triangle |
| Info | `info` *new* | 22 102 170 `#1666aa` (.501 .130 250) | 190 227 255 `#bee3ff` (.898 .055 241) | Info glyphs and text, always with the circle |
| Switch off track | `toggle-off` *new* | 143 143 163 `#8f8fa3` | 117 120 151 `#757897` | ToggleSwitch when off |

**Chrome tier.** The dark chrome over the chart (status bar, panel rail, toolbar row, elevation header, offscreen badges) is mid-tone in light and dark in dark. `.surface-chrome` on those roots sets status values that pass 4.5:1 on both:

| Token | Value | On light chrome | On dark chrome |
|---|---|---|---|
| `danger` | 255 205 199 | 4.53 | 9.75 |
| `warning` | 255 218 124 | 4.77 | 10.25 |
| `info` | 190 227 255 | 4.78 | 10.29 |
| `accent-strong` | 119 239 220 | 4.64 | 9.99 |

`accent` is not overridden on the chrome. It is the same mint in both themes: 4.64:1 on the light chrome and 9.99:1 on the dark. White/80 text stays at 4.80 and 9.43.

`.surface-chrome` cascades to every descendant. Put it on roots whose descendants are all chrome, not on a root that also contains light faces or popups. The toolbar flyout (white faces on `popover`, inside the toolbar row's DOM) is the case to watch: under `.surface-chrome` its `accent-strong`, `danger` and `focus-out` would flip to the pale chrome values. Today nothing in the flyout uses them, so this is a caveat, not a defect. If a flyout face ever needs one of those roles, move the class inward to the chrome parts.

**Shadows** (`tailwind.colors.js` `boxShadow`, themes.css):

- `shadow-pressed`, the sink: light `inset 0 1px 3px rgb(48 51 77 / .35)`, dark `… rgb(0 0 0 / .5)`.
- The glow is today's `shadow-md` geometry in mint, set by the recipes as `--glow`, and red (`danger-fill`) on destructive buttons.
- There is no latched shadow: the on-state is flat.

`index.html` `theme-color` stays `#77efdc`.

---

## 4. Contrast and distinction (computed from the source files)

WCAG 2 relative luminance. ΔE is OKLab ×100, where about 2 is the threshold of noticing. Colour-vision deficiency is simulated with Machado 2009 at severity 1.0 (p protan, d deutan, t tritan). The script is `scratchpad/color-final/tables.py`, run against `color/final/themes.css`.

### 4.1 Text and glyphs on their face (need 4.5)

| Pair | Light | Dark |
|---|---|---|
| `on-primary` on `primary` (and its focus ring) | 9.27 | 5.99 |
| `on-primary` on `primary-press` | 6.07 | 7.99 |
| `fg` on `button` (secondary label, its ring) | 9.27 | 6.19 |
| `fg-strong` on `press` | 6.98 | 4.69 |
| `on-danger` on `danger-fill` (and ring) | 6.47 | 5.28 |
| `on-danger` on `danger-press` | 4.57 | 6.91 |
| `danger` on `button` (quiet label, its ring) | 6.47 | 5.02 |
| `danger` on `popup` / `popup-hover` (menu row) | 6.47 / 5.42 | 6.37 / 5.34 |
| `danger` on `modal` (error line) | 5.42 | 7.84 |
| `on-accent` on `accent` / `accent-press` | 8.89 / 6.04 | 8.89 / 6.04 |
| `fg-strong` on a ghost press over modal / popup / a raised face | 6.89 / 8.03 / 8.03 | 6.65 / 5.63 / 4.69 |
| `fg-strong` on `band-press` | 11.02 | 5.17 |
| white on `chrome-press` | 8.41 | 7.30 |
| `fg` on `selected` (checked row) | 6.43 | 6.22 |
| `warning` on `modal` / `button` | 4.72 / 5.64 | 9.54 / 6.10 |
| `info` on `modal` / `button` | 5.01 / 5.97 | 9.57 / 6.12 |

### 4.2 Indicators and edges (need 3)

| Pair | Light | Dark |
|---|---|---|
| `accent-strong` on `button` (current-and-checked ring) | 4.81 | 5.94 |
| `accent-strong` on `selected` (drop ring on its tint) | 3.33 | 5.98 |
| `knob` on `toggle-off` | 3.17 | 4.29 |
| `toggle-off` on `button` | 3.17 | 1.92 ¹ |
| `on-accent` knob on `accent` track | 8.89 | 8.89 |
| `accent` on `bg` (peek ring; tool in use over the chart) | 6.80 | 10.87 |
| `primary` on `modal` (fill edge) | 7.77 | 5.12 |
| `danger-fill` on `modal` (fill edge) | 5.42 | 4.51 |
| `fg` on `header` (band tab marker) | 4.97 | 7.97 |
| `change` on `bg` (canvas marks) | 4.50 | 7.18 |

¹ In dark the off state is the white knob, at 4.29:1 on the track and 8.2:1 on the pill. Raising the track to 3:1 against the pill would drop the knob below 3:1 on it.

### 4.3 Roles that must differ (fill against fill, with CVD)

| Pair | Light: ratio; ΔE normal, p, d, t | Dark | Verdict |
|---|---|---|---|
| primary vs on (mint) | 6.70; 50, 52, 48, 49 | 1.81; 22, 21, 17, 20 | Distinct in both themes, also for CVD. v3 dark was deutan 2.0 |
| primary vs danger-fill | 1.43; 24, 12, 20, 27 | 1.13; 18, 15, 15, 22 | Hue and form; they never share a footer (one filled button) |
| primary vs secondary | 9.27; 60 | 3.28; 29 | Distinct |
| on vs secondary | 1.38; 17, 8, 13, 19 | 5.94; 47 | Light: the mint fill differs from white mainly in hue. The knob, the eye swap or flatness carries the state (principle 11) |
| press vs on | 1.27; 14, 11, **6**, 14 | 3.83; 37 | Distinct. The light press is darker than mint for this; at v3's lighter grey it was deutan 1.6 |
| press vs secondary rest | 1.76; 18 | 1.55; 10 | A clear step, plus the sink and the glow |
| on pressed vs on | 1.47; 12 | 1.47; 12 | Clear |
| danger label vs fg label | 1.43; 24, 12, 20, 27 | 1.23; 10, 10, 7, 12 | The quiet destructive pill reads red, also for CVD |
| checked row vs modal | 1.21; 10, 5, 7, 10 | 1.55; 12, 12, 10, 11 | The checkbox carries the state; the tint is support (v3 light was protan 1.5) |
| checked row vs current row | 1.44; 14 | 1.01; 7, 5, 4, 5 | When the current row is also checked it adds the `accent-strong` ring |
| warning vs danger | 1.15; 13, 9, **1**, 11 | 1.22; 13, 13, 10, 6 | Deutan-confusable in light; always told apart by glyph and words (principle 5), and they do not share a surface |

### 4.4 Press steps: hover is one step, press one more (ΔE rest→hover / hover→press / rest→press)

| Surface | Light | Dark |
|---|---|---|
| Raised pill (hover is the glow; face unchanged) | 0 / 18.4 / 18.4, plus sink and glow | 0 / 10.2 / 10.2, plus sink and glow |
| Ghost on a panel | 5.1 / 7.5 / 12.6 | 6.6 / 6.5 / 13.1 |
| Menu row on a popup | 6.1 / 8.0 / 14.0 | 4.3 / 7.5 / 11.6 |
| Ghost on a band (`band-press`) | 8.2 / 8.0 / 16.2 | 7.2 / 6.7 / 13.9 |
| Ghost on the chrome (`chrome-press`) | 5.5 / 11.7 / 6.3 (darkens, principle 9) | 8.1 / 7.8 / 15.8 |
| Primary | 0 / 9.9 | 0 / 8.1 |
| Destructive fill | 0 / 8.2 | 0 / 7.5 |
| On (mint) | 0 / 11.7 | 0 / 11.7 |

v3 had press against hover at ΔE 3.4 on light bands and 6.1 (1.30:1) on dark pills; both are now at least 6.5, and every raised press adds the sink and the glow.

### 4.5 Before and after, for the findings

- Switch knob on: 1.38:1 (white on mint) → 8.89:1 (ink knob).
- Light drop ring: 1.35:1 → 3.33:1 on its tint.
- Light status warning text: 4.46:1 → 4.77:1. Info glyph: 3.86:1 → 4.78:1.
- Dark destructive fill: pale pink, lighter than the neutral pill → coral with 5.28:1 ink.
- Dark press: 1.30:1 from rest (v3) → 1.55:1, plus a 10 ΔE face step, the sink and the glow.
- Light press: a grey that looked disabled (v3) → a lavender step toward the ink, with stronger ink and the glow.

---

## 5. Role decisions

### 5.1 What shares a colour, and what tells it apart

| Role | Colour | Told apart by |
|---|---|---|
| On: switch, tool in use, Show Edits, Select, snap | `accent` fill | Flat; knob, eye swap |
| Current on the dark chrome (rail tab) | `accent` 3 px bar | A bar |
| Mode in force (peek) | `accent` 2 px inset ring round the pane | A ring round the pane |
| Checked rows | `selected` + checkbox | Tint and mark |
| Drop target | `selected` + `accent-strong` ring | A ring on the row |
| Quick notice | `accent` pill | Fades; takes no input |
| Primary | `primary` fill | The one filled button |
| Destructive confirm | `danger-fill` | Label; red |
| Destructive choice | `danger` label on a neutral pill | Quiet until pressed |
| Error | `danger` text | Glyph, `role="alert"` |
| Warning / info | `warning` / `info` | Triangle / circle |
| Current in a single-select list | `button` + `shadow-md` | Raised pill |
| Band tab marker | `fg` 4 px bar | A bar |
| Hover | mint glow / one tint step | Pointer only |
| Press | `press` / `ghost-press` / fill step | Sunk; stronger ink; glow |
| Focus | the face's ink | A 2 px ring 2 px inside |
| Disabled | opacity 40 (rows 60) | Faded ink |

### 5.2 Dialog footers

- **At most one filled button, the one Enter presses:**
  - ChoiceModal: the safe default;
  - ConfirmModal: its confirm;
  - InfoModal: OK;
  - form dialogs: Apply or Save.
- When Cancel is the safe default (`cancelIsDefault`), Cancel is the primary.
- **Destructive confirm** (ConfirmModal `destructive`): `btn-danger`, filled red, focused. The user already asked to delete, the delete is undoable, and the filled button stays the Enter target.
- **Destructive choice beside a safe default** (every ChoiceModal `danger` choice): `btn-danger-quiet`.
- **Others:** `btn-secondary`.
- Evidence: `desktop--choice.png`, `desktop--confirm.png`, `phone--choice.png`, `desktop--footers-press-compare.png`.

### 5.3 Restore and Back to Now

- **Restore** is undoable: `restoreEntry` pushes a `restore` entry, or nothing when it already matches. It is the commit of peek mode, so it is `btn-primary`.
- **Back to Now** is `btn-secondary`.
- In the strip, mint now marks only the mode: the ring and Show Edits. Evidence: `desktop--peek-bar.png`, `phone--peek-page.png`.

### 5.4 Selection

| What | How it is drawn |
|---|---|
| Current row in a single-select list (Manager, History, segments, asset rows) | `row-current` (raised pill) |
| Rows checked for an action | `row-checked`, at full strength, plus the checkbox |
| The current row while also checked | The raised pill plus a 2 px `accent-strong` inset ring |
| Drop target | `row-drop` |
| Go To current entry | `popup-hover` plus the check (unchanged) |
| History Now dot | `fg` |
| Tabs on a light band | A 4 px `fg` bar |
| Rail tab | A 3 px mint bar |

### 5.5 Switches and toggle buttons

- **Switch:** on is a mint track and an ink knob; off is a `toggle-off` track and the white knob. The field also reads Enabled or Disabled.
- **Toggle buttons** opt in with `.btn-toggle`, and the look follows `aria-pressed`:
  - on is mint and flat; pressed it is `accent-press`;
  - it hovers with the glow;
  - focus is the ring in `on-accent` ink.
- **Who opts in:**
  - toolbar tools, modes and open panels;
  - Show Edits;
  - Manager Select;
  - the elevation snap square.
- **Who does not:** toolbar value items keep their check, so they do not get `btn-toggle`. The tool's `aria-pressed` is `state.current`, which is also true for a value in use.

### 5.6 Notices and status

- **Quick notice:** the mint pill for every quick notice, as in v0.5.22.
- **Notice cards** stay neutral.
  - Severity, where a card needs it, is a leading glyph in `text-warning`, `text-danger` or `text-info`. That needs an optional `Notice.severity`, which is a follow-up and adds no strings.
  - The card's action is `btn-secondary`.
  - The new card look itself is plan step C2.
- **Status bar:** the root gets `.surface-chrome`.
  - The not-stored label and the warning glyphs are `text-warning`; info glyphs are `text-info`.
  - Text stays white/80.
  - Chips are small faces, so they ring 1 px outside, in white.
- Evidence: `desktop--status.png`, `desktop--status-focus.png`, `desktop--toast.png`, `desktop--card-press.png`.

### 5.7 Text fields

- `field` is raised, as a secondary button, and hovers with the glow. Focus is the inside ring.
- `aria-invalid="true"` adds a 2 px red ring at the edge. It is apart from the focus ring, which stays inside in the field's ink, so a focused invalid field shows both.
- It also does not look like a focused quiet-destructive button, whose red ring sits 2 px inside a pill.
- The four `aria-invalid` sites are ExportModal, ServerBody and ScaleSelectionModal (C2), and SaveDialog (C3).

### 5.8 Immediate destructive buttons

- **Reset Settings and Reset Shortcuts** (owner decision): a quiet red label (`btn-danger-quiet`) and a confirmation, specified in 8.3.
- **Remove for a stored asset not in use** (owner decision): a quiet red label and a confirmation, as for one in use, with its own message (8.4). It deletes stored data that may not be reloadable.
- **Reset to Default and Use Built-in for All** (owner decision): quiet red only, in C2. A confirm or undo for them is a follow-up, logged in `DECISIONS-LOG.md`.

---

## 6. Recipes (`src/controls.css`)

### 6.1 Mechanism

The recipes are CSS in `src/controls.css`, wrapped in `@layer components`, and registered by a small Tailwind plugin. That way every build context can use them: templates (`class="btn btn-secondary"`), global CSS, the landing pages, and **Vue `<style>` blocks** (`@apply ghost`).

The plugin is required. In Tailwind 3 a `<style>` block cannot `@apply` a class defined in another CSS file, and ManagerRow, PreviewTransport, PanelRail and TimelineList all style their controls in scoped CSS. This was verified by compiling a separate file with `@apply btn btn-secondary`, which expanded the recipe, `:active` and `:focus-visible` rules included, and with a two-recipe merge (`@apply ghost btn-toggle`), which showed the limit below. The prototype file is `editor/tests/design-capture/color-final.tw-plugin.cjs`.

```js
// tailwind.controls.js: the control recipes in src/controls.css, for every Tailwind build.
const { readFileSync } = require('node:fs')
const postcss = require('postcss')
const plugin = require('tailwindcss/plugin')

module.exports = plugin(({ addComponents }) => {
    const root = postcss.parse(readFileSync(require.resolve('./src/controls.css'), 'utf8'))
    const rules = []
    root.walkAtRules('layer', (layer) => rules.push(...layer.nodes.map((node) => node.clone())))
    addComponents(rules)
})
```

- Both `tailwind.config.js` and `tailwind.landing.config.js` add `plugins: [require('./tailwind.controls')]`.
- Dev servers must restart after editing `controls.css`, as after a config change.
- Recipes set colour, elevation, state and focus only. Size and shape stay at the call site.
- **Compound recipe selectors do not carry through a merged `@apply`.** `.row-checked.row-current` becomes `.x.row-current` and `.row-checked.x`, and neither matches. Combine such classes at the call site. A rule that must hold in scoped CSS is written with one recipe class: the on-toggle hover glow is `.btn-toggle[aria-pressed='true']:hover:not(:active)`, not `.ghost.btn-toggle…`.
- **Hover sits under `(hover: hover) and (pointer: fine)`,** the query Tailwind's `hover:` emits under `hoverOnlyWhenSupported`, which the 71 sites it replaces used. A device that reports hover with a coarse pointer therefore keeps no glow after a tap.

### 6.2 The recipes

| Recipe | Rest | Hover (pointer) | Press (`:active`, `.is-pressed`) | Focus | Disabled |
|---|---|---|---|---|---|
| `btn btn-secondary` | `button`, raised | Mint glow | `press`, `fg-strong`, sink and glow | Ring inside, `fg` | 40 % |
| `btn btn-primary` | `primary`, raised | Mint glow | `primary-press`, sink and glow | Ring inside, `on-primary` | 40 % |
| `btn btn-danger` | `danger-fill`, raised | Red glow | `danger-press`, sink and red glow | Ring inside, `on-danger` | 40 % |
| `btn btn-danger-quiet` | `button` with a `danger` label | Red glow | `danger-fill` with `on-danger`, sink and red glow | Ring inside, `danger` | 40 % |
| `btn-toggle[aria-pressed='true']` (on a `btn` or `ghost`) | `accent`, flat | Glow (`.btn-toggle[aria-pressed='true']:hover:not(:active)`) | `accent-press`, sink and glow (`btn`) | Ring inside, `on-accent` | 40 % |
| `ghost` | No face | `fg/10` | `ghost-press`, `fg-strong` | Ring inside, its ink | 40 % |
| `ghost ghost-band` | No face | `band-hover` | `band-press`, `fg-strong` | Ring inside | 40 % |
| `ghost ghost-chrome` | white/80 ink | white/10, white ink | `chrome-press`, white | Ring inside, white | 40 % |
| `field` | `button`, raised | Mint glow | — | Ring inside on `:focus` | 40 % |
| `field[aria-invalid='true']` | Adds a 2 px `danger` edge ring | | | Both rings | |
| `row-current` / `row-checked` / `row-drop` | See 5.4 | | | | |
| `switch-track` (+ `[data-on]`), `switch-knob` | See 5.5 | | | | |
| `focus-ring` | Only the focus rule, for elements that are not buttons | | | | |
| `focus-edge` | For rows and menu rows: a transparent 2 px edge outline that takes `fg` on `:focus-visible` (principle 10) | | | Ring at the edge, `fg` | |
| `focus-out` | For faces under 32 px: the ring 1 px outside in `fg` (white inside `.surface-chrome`) | | | | |
| `holds-open` | Opt-in: hold the hover look while `aria-expanded='true'` | | | | |
| `surface-chrome` | The chrome tier (3.1) | | | | |

**Open triggers:**

- `.btn` and `.ghost` with `[aria-haspopup][aria-expanded='true']` (or `.holds-open`) hold their hover look, except while pressed.
- That covers Brush Add, change options (…), the row More button, the Manager bulk Move and More buttons and Go To (`aria-haspopup="dialog"`). Go To gains the open state that the affordance review found missing.
- Disclosures that should hold open, such as PreviewSettings, add `.holds-open`.

**Order inside the file matters** and is commented in it: rest, then the on-state, then hover, then open, then press, then the on-state's press. Equal-specificity rules therefore resolve press over hover and on over hover.

**Inner-face pattern.** When the painted face is a child of the focusable element, as in the History band tab pill or a field's value text, the parent's state steps the child with the same tokens:

- `.history-tab:active .history-tab-pill { @apply bg-band-press text-fg-strong }`;
- `.group:active .value { @apply text-fg-strong }`.

Prefer making the face the element.

### 6.3 Current uses of the attributes the recipes read (checked 2026-10-19)

| Attribute | Where | Meaning | Recipe effect |
|---|---|---|---|
| `aria-pressed` | LevelEditorToolbarTool `pressed` = `state.current` | Tool, mode or open panel in use; **also a value in use** | Only tools, modes and panels add `btn-toggle`; values keep the check |
| | ChangeArrows Show Edits | On/off | `ghost btn-toggle` |
| | ManagerRow `.manager-name` | **Checked row** while selecting | None (not a toggle); the row takes `row-checked` |
| | ManagerRow `.manager-mode` | Select on | `ghost btn-toggle` |
| | ElevationEditor `.elevation-square` | Snap grid on | `btn btn-secondary btn-toggle` |
| `aria-haspopup` + `aria-expanded` | ChangeArrows options, BrushPropertiesFields Add, ManagerList bulk Move and More, ManagerRow More (`menu`); HistoryPanel Go To (`dialog`) | A popup is open | Holds the hover look |
| `aria-expanded` alone | TimelineList groups, ManagerRow folders, PropertiesPanel sections, PropertiesBlock, PanelRail tabs and toggle, PreviewTransport, toolbar groups | Disclosure | None, unless `.holds-open` (PreviewSettings only) |
| `aria-invalid` | ExportModal, ServerBody, ScaleSelectionModal, SaveDialog | Invalid field | `field` red edge |
| `.is-pressed` (class) | PreviewTransport held step (today `is-held`), toolbar flyout row under a press-drag (today `!bg-accent`) | Held | The press look |

---

## 7. Do and don't

| Do | Why | Exceptions |
|---|---|---|
| Use a recipe for every button, field and row state | One definition, guard-checked, and states that agree everywhere | Chart content; the inner-face pattern uses the same tokens |
| Put state on the element as ARIA, and opt the control in (`btn-toggle`, `holds-open`) | The look and the announced state cannot disagree; other uses of the attribute stay unstyled | Rows use their row classes |
| Keep one filled button per footer: the one Enter presses | The safe path is the strongest, and the Enter target is clear | — |
| Check a new role against existing roles fill against fill, under CVD | Hue alone vanishes for 1 man in 12 | — |
| Check a focus ring against both sides | A ring on one contrast edge merges with the other | — |
| Treat anything held as a press | A press must never look on | — |
| Pair warning, info and error colours with their glyphs and words | Amber and red are deutan-confusable | — |
| Put `.surface-chrome` on a new dark-chrome root | Its status colours pass on both chromes | — |

| Don't | Why | Exceptions |
|---|---|---|
| Give an action `bg-accent` | Mint means on | — |
| Press anything to a mint fill | A mint fill would read as on | Pressing something already on deepens its own mint (`accent-press`); the press glow is mint, because a shadow is never a fill |
| Fill a destructive choice that sits beside a safe default | It competes with the Enter target | The destructive confirm fills, because it is the Enter target |
| Use mint for thin marks on light surfaces | 1.35–1.85:1 | `accent-strong` |
| Key a style on a bare `aria-*` attribute | One attribute has several meanings (6.3) | — |
| Show disabled with a hue | Opacity says unavailable in every role | — |
| Tint a card for severity | A glyph is enough, and the surface stays calm | — |
| Retune a token without its consumers | Partial landings fade or break states | — |

---

## 8. Behaviour changes in C0 (owner decisions 3 and 4)

### 8.1 Press feedback: the decision

The owner first chose neutral only, then allowed a mint glow on 2026-10-19 ("whichever reads best as a press"). Three treatments were prototyped side by side, in the specimen and in the dialog footers, in both themes, with touch (`:active` alone) and mouse presses:

1. neutral only: face step, stronger ink and sink;
2. neutral plus the mint glow;
3. the glow without the sink.

Evidence: `desktop--pressvariants.png`, `phone--pressvariants.png`, `desktop--footers-press-compare.png`, `phone--footers-press-compare.png`, and the `--after-neutral` column of every sheet.

**Chosen: neutral plus the glow on raised controls. The owner confirmed this on 2026-10-19 after seeing the sheets.**

- **Dark theme.** Neutral alone is the weakest press there: label contrast caps the face step (1.55:1). The glow makes a tap unmistakable on the dark chart, the dark modal and the transport strip.
- **Light theme.** The glow removes the remaining disabled reading: disabled never glows, and a pressed face does.
- **On a mouse,** pressing keeps the hover's glow while the face drops a tone and sinks, so the press reads as more of the hover rather than as the glow switching off.
- **It cannot read as on.** The glow is a shadow and on is a flat mint fill. A pressed control also has a sunk, non-mint face (deutan ΔE 6 from mint in light).
- **The sink stays,** for a non-colour cue and for continuity with the inset `shadow-track` of recessed controls. Without it (variant 3) the look is nearly the same, so the cost is nil.
- **Ghosts do not glow:** they have no face or elevation, and a halo under a translucent tint looks like a smudge.

### 8.2 ConfirmModal: the accidental-activation guard

- **Today:** a held or doubled Enter confirms a destructive delete. Enter on the menu's Delete row opens the confirm on keydown with focus on Delete, and ConfirmModal has none of ChoiceModal's guard (critique, safety note).
- **Change:** ConfirmModal ignores activations within `GUARD_MS` (300 ms) of opening and swallows key repeat on Enter and Space, exactly as ChoiceModal does. Focus stays on Delete. There is no visual and no string change.
- **Shared code.** One rule in one place, applied to every component that shares the risk (root cause RC9):

```ts
// src/modals/activationGuard.ts
/** Activations within this long of a dialog opening are ignored (Part 1 §1.4.1). */
export const GUARD_MS = 300

/** A press within the first moments, or a held key, is not a choice. Call during setup. */
export const useActivationGuard = () => {
    const openedAt = performance.now()
    return {
        accidental: () => performance.now() - openedAt < GUARD_MS,
        /** On the button row, in the capture phase: key repeat never reaches the focused button. */
        onKeydown: (event: KeyboardEvent) => {
            if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                event.stopPropagation()
            }
        },
    }
}
```

- **Wiring:**
  - `choice.ts` re-exports `GUARD_MS` from it, which avoids an import cycle through ChoiceModal.
  - ChoiceModal and ConfirmModal call `useActivationGuard()`.
  - ConfirmModal's buttons return early when `accidental()`, and its button row gets `@keydown.capture="onKeydown"`.
  - The ×, Esc and outside presses stay unguarded, because closing is safe.
- **Test:** a new `tests/browser/confirmDialog.spec.ts`, mirroring choiceDialog's held-Enter test:
  - a held Enter and a doubled Enter (80 ms) do not confirm;
  - a fresh press after 300 ms does;
  - focus on open is Delete.

### 8.3 Reset Settings and Reset Shortcuts: confirm

- **Buttons:** both become `btn btn-danger-quiet`.
- **Dialog:** each opens ChoiceModal with its own label as the title and as the destructive button, a new message, and `cancelIsDefault: true`. Cancel is therefore primary, focused and rightmost, or on top when stacked on a phone.
- **Why Cancel is the safe default:** a reset cannot be undone. This is the existing pattern for Remove on a stored asset that is in use. ConfirmModal's focus-on-action is kept for undoable deletes (8.2).
- **Guard:** ChoiceModal's guard applies.
- **Strings:** two new messages in all seven locales, with the reasons, in `color/strings-reset-confirm.md`.
- **Notices:** none follows, as today.
- **Message kept:** the owner kept "Restore default settings, keeping keyboard shortcuts?" with its scope phrase, because touch users have no tooltip to say that shortcuts survive.
- Evidence: `desktop--reset-confirm-locales.png`, `phone--reset-confirm.png`, `desktop--settings.png`, `desktop--settings-press-reset.png`.

### 8.4 Remove an unused stored asset: confirm

- **Today:** Remove on a stored preview asset asks first only when a type uses it (`removeInUse`); an unused one is deleted at once. That is stored data, which the user may not be able to load again.
- **Change (owner decision):** every Remove confirms. The unused one reuses the in-use dialog: title and danger button `remove`, a new message `commands.previewAssets.removeUnused`, `cancelIsDefault: true`, so Cancel is the focused primary and a stray Enter removes nothing.
- **Strings:** one new key in seven locales, in `color/strings-reset-confirm.md` section 3.
- **Code:** `StoredAssets.vue` picks the message by `row.users.length` and always confirms. The file moves from colour package C2 to C0, so the safety change and all three new strings land together.
- **Test:** `previewAssetsFile.spec.ts:678–682` ("One that is not in use goes at once") now confirms.
- **Plan line:** `plan/plan.md`, Stored tab paragraph (about line 6450, "Removing one in use asks first"), needs one line for this. The lead owns the plan text.

---

## 9. Old → new

### 9.1 Accent uses (inventory 2.1 and 2.2)

| Category | Lines | Old | New |
|---|---|---|---|
| Press | 117 | `active:` / `group-active:` / `peer-active:` / `has-[:active]:bg-accent text-on-accent` | The recipe's press: `press`, `ghost-press`, `band-press` or `chrome-press`, with `fg-strong`; filled faces use their own `*-press` |
| Hover | 71 | `hover:shadow-accent` | `.btn` hover (the same mint glow), red on destructive buttons |
| Focus | 14 accent + 99 fg | `ring-accent`, `ring-fg`, `ring-white`, accent box-shadows | The recipe ring (inside, own ink); `focus-out` on small faces; `focus-edge` on rows and menu rows |
| Primary | 14 | `bg-accent text-on-accent active:bg-button active:text-fg` | `btn btn-primary` |
| On / held | 7 | `bg-accent` | `btn-toggle` (on); held transport → `.is-pressed` (a press); Brush Add open → holds its hover glow; PreviewSettings open → `holds-open` |
| Switch track | — | `bg-accent` / `bg-fg/25`, knob tinted on press | `switch-track` / `switch-knob`; no knob tint |
| Current marker | 2 | Rail bar; ManagerRow current+checked `ring-accent` | Rail bar unchanged; ring → `accent-strong` |
| Drop target | 1 | `bg-selected/35 ring-accent` | `row-drop` |
| Drag-over (flyout `quickOver`) | 1 | `!bg-accent` | `.is-pressed` |
| Peek ring | 1 | `ring-accent` | Unchanged |
| Filter dot | 1 | `bg-accent` | Removed (DEC-8.5); `accent-strong` if kept |
| Offscreen badge hover ring | 1 | `ring-accent` | `ring-white/60` (chrome hover) |
| Resize line | 1 | Accent while dragged or focused, accent/60 hovered | White/60 hovered, white when dragged or focused. A drag is a press, and white is the chrome's ink |
| Spinner | 1 | StartupGate `text-accent` | `text-fg`, as every other spinner |
| Quick notice, brand | 4 | Mint | Unchanged |
| Chip ink, forced-colours icon ink | 3 | `text-on-accent` | Unchanged (ink, not a role) |

### 9.2 Other highlight colours (inventory 2.3)

| Category | Old | New |
|---|---|---|
| Selected segment, radio row, History row, asset row | Raised `bg-button` | `row-current` or the same tokens (unchanged look) |
| Rows checked for an action | `bg-selected/40` | `row-checked` (full strength, retuned) |
| Row hover | `bg-fg/10`, `bg-button/70`, `popup-hover` | Unchanged; press steps beyond it |
| Rail selected tab | white/10 + mint bar; press hides the bar | Unchanged; press `chrome-press`, and the bar stays |
| Manager band Select on | `bg-fg text-header` | Mint and flat (`ghost btn-toggle`): an on-state like every other. An ink fill would now read as a primary |
| Tool in use | Mint, `focus-visible:ring-white` | Mint and flat; ring inside in `on-accent` |
| Disabled | Opacity 40 / 60 / 70 | Unchanged |

### 9.3 Raw palette and literals (inventory 2.4)

| Where | Old | New |
|---|---|---|
| StatusLabel | `text-amber-300` | `text-warning` (chrome tier) |
| FileChip | `text-amber-300` / `text-sky-300` | `text-warning` / `text-info` |
| PanelRail chevron | `rgb(255 255 255 / .1)` | `bg-white/10` (`ghost-chrome` hover) |
| Command chips `bpm.ts`, `timeScale.ts` | `bg-[#f0f]`, `bg-[#ff0]` | Unchanged: they name chart objects (exempt) |
| Dock edge shadows | `rgb(0 0 0 / .45)` | Unchanged: geometry, not a role |

### 9.4 Destructive and overwriting actions (inventory 4.1)

| Action | New look |
|---|---|
| Delete groups / stages / folders (ConfirmModal) | `btn-danger`, focused, guarded (8.2) |
| Destructive menu rows (Delete selection, Delete group or folder) | `.popup-item.text-danger` (unchanged markup); presses `danger-fill` |
| Replace on save or export conflict, Leave Anyway, Discard recovery, Remove an asset in use | `btn-danger-quiet`; the safe default `btn-primary` |
| Reset Settings, Reset Shortcuts | `btn-danger-quiet` + confirmation (8.3) |
| Remove an unused stored asset | `btn-danger-quiet` + confirmation (8.4) |
| Reset to Default, Use Built-in for All | `btn-danger-quiet` only; a confirm or undo is a follow-up |
| History Restore | `btn-primary` (undoable) |
| Restore as a Copy, Restore Session | `btn-secondary` |
| Dynamic stages confirm | `btn-primary` |

---

## 10. History surfaces (C8, folded into the History redesign)

The History implementers read `../proposal.md`. Its F-specs still name the old roles (`bg-accent`, `active:bg-accent`, `ring-fg`, `hover:bg-header-hover`). `proposal.md` and `IMPLEMENTATION-BRIEF.md` carry a banner saying so. Wherever an F-spec gives a colour, state or focus class, use this column instead. Geometry is unchanged. Keyed by element:

| F-spec, element | Replace the colour, state and focus classes with |
|---|---|
| R1 / PeekBar pane ring | `ring-2 ring-inset ring-accent` (unchanged; allowlisted: a mode in force) |
| F01 `[data-peek-details]` date button | `ghost` (hover `fg/10`, which in light equals `header-hover` within ΔE 1; press `ghost-press`; focus inside) |
| F01 `[data-peek-back]` | `btn btn-secondary` |
| F01 `[data-peek-restore]` | `btn btn-primary`. The F-spec's `ring-inset ring-fg` is invisible on ink; the recipe's ring is `on-primary` |
| F01 spinner | `border-fg/25 border-t-fg` (unchanged) |
| F03 `[data-show-edits]` (24 px) | `ghost btn-toggle focus-out` with `:aria-pressed`; delete `bg-accent … hover:bg-accent/80 active:bg-button`; on = mint face, off = no face with the hidden eye |
| F03 `[data-change-options]` (24 px) | `ghost focus-out`; its `aria-haspopup` + `aria-expanded` hold the open look; delete `{ 'bg-header-hover': menuOpen }` |
| F03 `[data-property-summary]` (24 px) | `ghost focus-out` |
| F03 arrows | `[control, enabled(direction) ? 'ghost focus-out' : 'focus-out']` (disabled arrows take no hover or press); keep the 40 % child opacity |
| F03 forced colours | Covered by the recipe (`btn-toggle` on → Highlight); delete the pressed retarget |
| F09 Go To | `btn btn-secondary` (its `aria-haspopup="dialog"` + `aria-expanded` now hold the glow while open) |
| F10 band tabs | The inner-face pattern on the band: `.history-tab:hover .history-tab-pill { bg-band-hover }`, `:active … { bg-band-press text-fg-strong }`, `:focus-visible … { outline 2px currentColor, offset -4px }`; marker `bg-fg` (unchanged) |
| F11 Go To rows `.goto-item:active` | `bg-ghost-press text-fg-strong` |
| F12 filter dot | Removed (DEC-8.5); if kept, `bg-accent-strong` |
| F13 History dialog footer | View Chart `btn btn-secondary`; close `ghost ghost-band` (BaseModal, C1) |
| F15 row pill `::before` | Selected `bg-button shadow-md` (the `row-current` tokens on a pseudo-element); hover `bg-button/70` (unchanged) |
| F15 main-pill press | `bg-ghost-press text-fg-strong` (was `bg-accent text-on-accent`) |
| F15 focus | Row pill and main pill take `focus-edge` (replacing `ring-2 ring-inset ring-fg`): the row exception (principle 10), since `fg` contrasts with the pill and the modal |
| F16 guide line | `bg-fg/30` (unchanged) |
| F17 disclosure | `ghost` (delete `hover:bg-fg/10 … active:bg-accent … ring-fg`) |
| F18 Details pill on unavailable rows | `ghost` |
| Step Details, Property Changes: Show More, View Chart, Try Again | `btn btn-secondary` |
| Status badge | `bg-fg/8` chip (unchanged) |
| Change marks | Canvas orange via `--color-change` (C9) |

Spec `historyPanel.spec.ts` (the accent shadow) belongs to C8.

---

## 11. The guard test

`tests/editor/colorRoles.test.ts` (node test, in `npm test`). The prototype is `editor/tests/design-capture/color-final-guard.mjs`, which C0 ports.

### 11.1 What it scans

- Every `src/**/*.{vue,ts,css}`, as text.
- Template and TS class strings and `@apply` lines are tokenised with their variant prefixes.
- CSS rules (in `.css` and `<style>` blocks) are parsed, so a rule's selector supplies the state for the `@apply`, `theme('colors.*')` and `var(--color-*)` uses in its body.
- Comments are stripped.

### 11.2 What it forbids outside `src/themes.css` and `src/controls.css`

| Rule | Catches | Reason |
|---|---|---|
| `press-is-mint` | Mint, or any `bg-`, `text-`, `fill-`, `ring-`, `border-` (and the other colour prefixes) `on-accent`, with or without an opacity, under any press variant (`active:`, `group-active:`, `peer-active:`, `has-[:active]:`, `enabled:active:`, `[.popup-item:enabled:active_&]:`), and any CSS rule whose selector is `:active`, `.is-held`, `.is-pressed` or `-pressed` (ignoring `:not(:active)`) with mint in its body | Press is never on |
| `mint-outside-recipes` | `bg-` / `text-` / `ring-` / `fill-` / `border-` / `outline-` / `shadow-` with `accent`, `accent-press`, `accent-strong` or `selected`; `theme('colors.accent' / 'on-accent' / 'selected')`; `var(--color-accent / on-accent / selected)` | On-states come from recipes; **bare `bg-accent` included** |
| `hover-glow-outside-recipes` | `shadow-accent` with any variant | The glow lives in `.btn` |
| `focus-colour` | `focus:`, `focus-visible:` or `group-focus-visible:` with `ring-` / `outline-` in `fg`, `white`, `current`, `on-accent` or mint, and CSS `:focus` rules with mint | Focus comes from the recipes. Rows and menu rows use `focus-edge`, which carries no colour prefix, so it passes; `.popup-item` in `index.css` moves to it in C0 |
| `focus-outline-none` | `focus:outline-none` or `focus-visible:outline-none` (in a class string or `@apply`) in a non-exempt file | The recipe ring sits in the components layer, and a leftover `outline-none` of equal specificity in the later utilities layer removes it without any visible error. 29 sites today |
| `danger-fill-outside-recipes` | `bg-danger` | `.btn-danger` / `danger-fill` |
| `raw-palette` | Tailwind palette colours (`amber-300`, `sky-300`, …) | Tokens |
| `colour-literal` | `bg-[#…]`, `text-[rgb(…)]` | Tokens |

### 11.3 Exemptions and allowances

**Exempt files** (chart content), each with its reason:

- `src/editor/canvas/**`
- the elevation canvas files (not `ElevationEditor.vue`)
- `src/preview/render*` and `usePreviewRendering.ts`
- `src/utils/colors.ts`
- `NoteShapeIcon.vue`
- `commands/bpm.ts` and `timeScale.ts`

**Allowed mint outside recipes.** Each entry is a file, a pattern the line must match, and a reason:

| File | Allowed | Reason |
|---|---|---|
| QuickNotice.vue | `colors.(on-)accent` | The quick notice |
| PanelRail.vue | `panel-tab-marker … bg-accent` | The current marker on the dark chrome |
| PeekBar.vue | `ring-accent` | Peek mode in force |
| PreviewSettings.vue | `shadow-accent` | Range thumbs take the hover glow and cannot take a class |

Adding to either list needs a reason in the entry.

### 11.4 Transition

- An allowlist file per package, `tests/editor/colorRoles/legacy-C1.txt` … `legacy-C8.txt`, lists only that package's flagged files, that is, the files that violate the guard today (section 12). A package file that is already clean (a token file, `choice.ts`, `activationGuard.ts`, a locale file, `LevelEditor.vue` in C6, `changes.ts`) is not listed, because the test fails on a listed file that is clean. C0 has no list: its files are fixed in its own commit.
- The test fails if a listed file is already clean, so stale entries cannot linger.
- Each package deletes its own list file as its last commit, so the lists are disjoint and conflict-free.
- C10 deletes the directory and its loader.

### 11.5 Validated on today's tree (main b89b1e39)

Command: `node tests/design-capture/color-final-guard.mjs --validate work/history-redesign/color/inventory.md`.

- **Totals:** 1297 files scanned; 468 findings; 13 allowed; 455 violations in 79 files. By rule: `press-is-mint` 200 and 11 as CSS rules, `focus-colour` 97 and 5 as CSS rules, `hover-glow-outside-recipes` 63, `mint-outside-recipes` 45, `focus-outline-none` 29, `raw-palette` 3, `danger-fill-outside-recipes` 2.
- **Inventory 2.1:** 181 rows. A row counts as flagged only when a finding is on its exact line, or the row's line is inside the CSS rule that a finding flags. There is no ±1-line tolerance.
  - All 172 press, hover, focus, primary, on, current, drop, drag, peek, badge, spinner and notice rows are flagged (0 missed). That includes:
    - the `@apply` rules: GoToList:335, HistoryPanel:386, PanelRail:470 and :536, ElevationEditor:2281;
    - the `theme()` rules: BaseField:643, selectLists.css:117, StatusLabel, StatusScope, FileChip, PanelRail:524.
  - None of the 9 legitimate ink, definition or comment rows is flagged.
- **Inventory 2.4:** both raw-palette rows are flagged.
- The 79 flagged files are a subset of the files that the packages C0–C8 list, and each is owned exactly once (checked by script: none unowned, none owned twice). By package: C0 8, C1 17, C2 9, C3 16, C4 8, C5 6, C6 4, C7 4, C8 7. The packages also own unflagged files: the tokens and configs, `choice.ts`, `activationGuard.ts`, the locales, `LevelEditor.vue` (C6, for `.surface-chrome`) and `changes.ts`.

**Plus permanent fixtures:** a unit test feeds one synthetic snippet per inventoried form through the detector and expects a hit. The forms are a class string, `group-active:`, `peer-active:`, `has-[:active]:`, `!bg-accent`, `@apply bg-accent` in an `:active` rule, `theme('colors.accent')` in a `:focus-visible` rule, `hover:shadow-accent`, `focus-visible:ring-white`, `focus-visible:outline-none`, `focus:outline-none`, `@apply focus-visible:outline-none`, `group-active:bg-on-accent/30`, `active:border-on-accent`, `text-amber-300` and `bg-[#fff]`. A second list of snippets must pass: the recipes (`btn btn-secondary`, `ghost ghost-band btn-toggle`, `row-checked row-current focus-edge`, `focus-out`), `text-danger bg-danger-fill text-on-danger`, `bg-ghost-press text-fg-strong` and a plain `outline-none`. The prototype runs both lists with `--fixtures` (19 must hit, 12 must pass, 0 wrong). The check keeps working after today's cases are gone.

---

## 12. Migration packages

**Process:**

- C0 lands first and alone. C1–C7 then run in parallel on one integration branch, and no release is made until C10. Between packages the UI is mixed (some dialogs ink, some mint).
- Every file belongs to exactly one package.
- Each package runs its targeted specs. The full Playwright suite runs once, after C10 (owner).
- Models and effort follow AGENTS.md: Sol 6.1 at medium or high implements; Astra at high reviews the design per package and owns C0's safety and translation parts.
- **Naming.** These are *colour packages*. They are not PLAN-OF-RECORD's closing steps C1–C4; say "colour package C3" in briefs.

### C0: foundation, safety, Reset and Remove confirmations, and checked-row consumers

Astra implements or reviews the guard and the strings; Sol implements the rest.

| Group | Files |
|---|---|
| Tokens and mechanism | `src/themes.css`, `tailwind.colors.js`, `tailwind.config.js`, `tailwind.landing.config.js`, new `tailwind.controls.js`, new `src/controls.css` |
| Global CSS | `src/index.css`: `.popup-item` press `enabled:active:bg-ghost-press enabled:active:text-fg-strong`; `.popup-item.text-danger:enabled:active { bg-danger-fill text-on-danger }`; focus `focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg` becomes `focus-edge`, so the guard's `focus-colour` and `focus-outline-none` rules pass |
| | `src/editor/LevelEditorContextMenu.vue`: the shortcut hint `[.popup-item:enabled:active_&]:text-on-accent` becomes `[.popup-item:enabled:active_&]:text-inherit` (`fg-strong`, or `on-danger` on the Delete row). It is the file's only violation, and it must change with the `.popup-item` press, or a pressed hint falls to 1.9:1 |
| | `src/selectLists.css`: option press `ghost-press` / `fg-strong` |
| Safety (8.2) | New `src/modals/activationGuard.ts`, `src/modals/ConfirmModal.vue`, `src/modals/ChoiceModal.vue`, `src/modals/choice.ts` (re-export `GUARD_MS`; doc comments say "primary", not "accent colour"). ConfirmModal and ChoiceModal also move to the recipes |
| Reset and Remove confirmations (8.3, 8.4) | `src/editor/settings/SettingsModal.vue`, `src/editor/commands/previewAssets/StoredAssets.vue`, `src/i18n/{en,ja,ko,zhs,zht,fr,tr}/index.json` (three new keys: `settings.resetSettingsMessage`, `settings.resetKeybindsMessage`, `commands.previewAssets.removeUnused`) |
| Retune consumers | `src/editor/workspace/manager/ManagerRow.vue`: the whole file, which keeps its own class names (`manager-row-selected`, `manager-row-drop`), so `managerSelection.spec` and `managerFolders.spec` need no change |
| Tests | New `tests/editor/colorRoles.test.ts` and `tests/editor/colorRoles/legacy-C1.txt` … `legacy-C8.txt`; new `tests/browser/confirmDialog.spec.ts` |
| | Updated: `settings.spec.ts`, `defaultPanels.spec.ts`, `previewHitboxes.spec.ts`, `shortcuts.spec.ts`, `localizations.spec.ts`, `forcedColors.spec.ts` (Reset buttons, dialogs, Manager) |
| | Updated: `choiceDialog.spec.ts:121` expects three distinct backgrounds for Cancel, Replace and Save as a Separate File; with Replace quiet there are two, so it asserts the danger choice's text colour or class instead. `themes.spec.ts:110` clicks Reset Settings, which now opens a confirmation. `previewAssetsFile.spec.ts:678–682` ("One that is not in use goes at once") now confirms |
| | Run: `managerSelection.spec.ts`, `managerFolders.spec.ts`, `managerModal.spec.ts`, and, because they touch ManagerRow, `managerPanels.spec.ts` (:832, the computed background of a dragged row), `managerDuplicate.spec.ts` and `hitAreas.spec.ts` |
| Docs | New `editor/docs/color-system.md` (this file). The design-language and checklist updates (section 15) go with plan step C3 |

ManagerRow's changes:

- `.manager-row-selected:not(.manager-row-current)` takes `row-checked`;
- current-and-checked takes the `accent-strong` ring;
- `.manager-row-drop` takes `row-drop`;
- `.manager-icon-button` takes `ghost` (`ghost-band` on the heading);
- `.manager-mode` adds `btn-toggle`;
- `.manager-name` presses `ghost-press`;
- focus goes inside.

Visible after C0:

- menu and select-list presses go neutral;
- dialogs that use ConfirmModal or ChoiceModal take ink primaries and quiet destructive choices;
- Settings shows the quiet Reset buttons and their confirmations, and Remove on every stored preview asset confirms;
- Manager rows are retuned.

Nothing else changes until used.

### C1–C7: parallel

| # | Package | Files | Specs |
|---|---|---|---|
| C1 | Dialog shells and form fields | `src/modals/BaseModal.vue`, `InfoModal.vue`; `src/modals/form/{FormModal, BaseField, ChoiceField, FileField, KeyField, MultiNumberField, MultiSelectField, MultiToggleField, NumberField, OptionalNumberField, OptionalSelectField, SelectField, TextField, ToggleField, ToggleSwitch}.vue` | `choiceFields.spec`, form specs |
| C2 | Command dialogs | `src/editor/commands/exportLevel/ExportModal.vue`; `previewAssets/{AlsoOptions, AssetRow, AssetSources, ChooserModeSwitch, ChooserView, PreviewAssetsModal, ServerBody}.vue` (`StoredAssets.vue` is in C0); `scaleSelection/ScaleSelectionModal.vue` | Export, preview-assets and scale specs; `aria-invalid` on three fields |
| C3 | Settings, utilities, save, startup, rendering, landing | `src/editor/settings/{DiagnosticsModal, SettingsAbout, SettingsIndex, SettingsLocalData, SettingsPreview, SettingsSection}.vue`, `settings/toolbar/SettingsToolbarAddButton.vue`; `src/editor/utilities/{UtilitiesModal, coverEditor/CoverEditorModal, previewEditor/PreviewEditorModal}.vue`; `src/editor/save/{PreparingDialog, SaveDialog}.vue`; `src/startup/{SafeModeBar, StartupGate}.vue`; `src/rendering/RenderingError.vue`; `src/landing/landing.css` | Save, startup, settings-section and landing specs |
| C4 | Workspace | `src/editor/workspace/{PanelRail, ResizeHandle}.vue`; `manager/{ManagerAddButton, ManagerList, ManagerModal, StagesManager}.vue`; `panels/PropertiesPanel.vue`; `properties/PropertiesBlock.vue` | `panelRail.spec:313` and `propertiesPanel.spec:376` assert the pressed fill is mint and now assert the neutral press, with the rail marker kept. Dropping the dark mint tune does not spare them |
| C5 | Toolbar, tools, elevation, badge | `src/editor/toolbar/{LevelEditorToolbar, LevelEditorToolbarTool}.vue`; `src/editor/tools/brush/BrushPropertiesFields.vue`, `tools/paste/PasteSidebar.vue`; `src/editor/elevation/ElevationEditor.vue`; `src/editor/OffscreenNoteBadge.vue` (`LevelEditorContextMenu.vue` is in C0) | `toolbarPressed`, `toolbarQuickSwitch`, `editorLayoutControls`, `elevationViewport` |
| C6 | Status bar and notices | `src/editor/{StatusLabel, StatusScope, NoticeCard, LevelEditor}.vue`; `src/editor/file/FileChip.vue` | Status and notice specs. The NoticeCard look itself is plan C2; C6 changes only its role classes |
| C7 | Preview | `src/preview/{AssetFallbackLine, LevelPreview, PreviewSettings, PreviewTransport}.vue` | Preview specs (held step → `.is-pressed`) |

C5 toolbar notes:

- tools, modes and open panels add `btn-toggle`; value items do not;
- the flyout's press-drag row uses `.is-pressed`;
- the elevation square is `btn-toggle`.

### C8–C10

- **C8, History:** `src/editor/history/{ChangeArrows, GoToIcon, GoToList, HistoryDialog, HistoryPanel, PeekBar, TimelineList}.vue`. Folded into the History redesign packages, which apply section 10 directly after C0. Spec: `historyPanel.spec`.
- **C9, change token (optional):** `src/editor/canvas/changes.ts` reads `--color-change` in place of its `#ff9b42`.
- **C10, close-out:** delete `tests/editor/colorRoles/` and its loader in `colorRoles.test.ts`. Remove leftover `peer-checked:peer-active` patches. Then run the full suite once.

**Scope.** About 300 class-string edits in 85 files, mostly mechanical; 7 browser specs with about 15 assertions on classes; three new strings in seven locales.

---

## 13. Out of scope: chart content and the change orange

Chart content keeps its own colours:

- notes, connectors, guides, grid and stages;
- the elevation canvas and the preview renderer;
- NoteShapeIcon;
- the BPM and time-scale chips;
- the `--note-accent` styles.

The change orange is chart content too: 4.50:1 and 7.18:1 on the chart. No UI element uses orange, so the marks stay the one hue nothing else on screen uses.

Light warning (h 68) and the change orange (h 59) are 9° apart, not 20°. They are told apart by lightness (L 0.52 against 0.78), and orange never appears on a UI surface. In dark they are 29° apart (h 88 against 59).

---

## 14. Evidence and re-run

All sheets are in `shots/final/sheets/`: BEFORE (main), AFTER (final), and AFTER, variant neutral. Raw captures are in `shots/final/raw/`. Open these first:

| Sheet | Shows |
|---|---|
| `desktop--specimen.png`, `phone--specimen.png` | Every family × rest, hover, press (mouse and touch), focus and disabled, plus menu rows and rows. BEFORE from today's class strings; AFTER from the compiled `controls.css` |
| `desktop--pressvariants.png`, `phone--pressvariants.png` | The press decision, side by side (touch) |
| `desktop--footers-press-compare.png`, `phone--footers-press-compare.png` | Dialog footers, every press: BEFORE / chosen / neutral only |
| `desktop--focus-compare.png` | The inside ring on ink, red, white, mint, the toolbar over the chart, the peek strip, the chrome chip and Select on |
| `desktop--reset-confirm-locales.png`, `phone--reset-confirm.png` | The new confirmation in seven locales, focus and press, stacked on phone |
| `desktop--choice.png`, `desktop--confirm.png`, `desktop--confirm-press-close.png` | Footer grammar; press-band on the dialog × |
| `desktop--peek-bar.png`, `phone--peek-page.png` | Restore ink or periwinkle, Show Edits mint, the whole phone while peeking |
| `desktop--toolbar-press.png`, `desktop--toolbar-press-on.png`, `desktop--toolbar-focus-on.png` | The tool in use flat; presses distinct from on |
| `desktop--groups-selecting.png`, `desktop--groups-drop.png`, `desktop--groups-press-band.png`, `desktop--groups-press-name.png` | Select on, checked rows, drop target, band press, row press |
| `desktop--settings.png`, `desktop--settings-press-reset.png` | Switches, quiet Reset |
| `desktop--status.png`, `desktop--status-focus.png`, `desktop--toast.png`, `desktop--card-press.png` | Chrome tier, chip focus, the toast unchanged, card press |
| `desktop--preview-held.png`, `desktop--preview-settings.png` | Held step is a press; PreviewSettings holds open |

**Harness** (untracked): `editor/tests/design-capture/color-final.spec.ts` with `color-final.config.ts`.

- It compiles `color/final/controls.css` with the editor's Tailwind and injects `color/final/themes.css`.
- It migrates live class strings to the recipes in the page, as the packages will.
- Scoped styles that a package rewrites are emulated with token-only rules.

Dev server on 5261 (main); never 5180. To re-run:

```
cd editor
NSE_CF_VARIANTS=neutral npx playwright test -c tests/design-capture/color-final.config.ts --workers=4
NSE_CF_PARTS=sheets npx playwright test -c tests/design-capture/color-final.config.ts --workers=1
node tests/design-capture/color-final-guard.mjs --validate ../work/history-redesign/color/inventory.md --fixtures
```

Env: `NSE_CF_TAG`, `NSE_CF_SCREENS`, `NSE_CF_DEVICES`, `NSE_CF_THEMES`, `NSE_CF_VARIANTS` (files in `color/final/variants/`), `NSE_CF_EXTRA`.

The History captures use today's peek geometry; colour is independent of the History layout decisions.

---

## 15. Risks and limits

- **Mixed UI between packages.** Use an integration branch and make no release until C10.
- **`controls.css` edits need a dev-server restart,** because they reach Tailwind through the plugin. This is noted in the file header.
- **Safari 16.0–16.3** draws outlines as rectangles, so the inside ring is square on rounded pills there. Focus stays visible; this is accepted under the old-iOS rule (practical scope).
- **Light theme, on against secondary,** differs mainly in hue (ΔE 17, protan 8). Form carries the state, as in v0.5.22.
- **Dark switch track off against the pill** is 1.92:1; the knob carries the state.
- **Light warning against danger** is deutan-confusable; the glyphs carry it.
- **The press glow is mint** (owner confirmed, 2026-10-19). It is a shadow, it lasts only while held, and the pressed face is sunk and non-mint, so it does not read as on. The neutral variant, one line in `color/final/variants/neutral.css`, remains as history.
- **Scoped styles cannot merge two recipe classes into one compound selector** (6.1). The on-toggle hover glow is written with one class for that reason; `.row-checked.row-current` is combined at the call site.
- **`.surface-chrome` cascades** (3.1). A face inside the toolbar flyout that used `accent-strong`, `danger` or `focus-out` would take the chrome values.
- **Docs elsewhere still describe v0.5.22 rules** until plan step C3 commits them. Corrected text is ready in `../design-language.md` §4, §5 and §9 rules 6 and 7, and in a new Colour section of `../ui-review-checklist.md`, both edited alongside this file.

---

## 16. Needs the owner

Nothing is open. The owner decided on 2026-10-19:

1. **The press glow stays** (8.1): neutral plus the mint glow on raised controls.
2. **Immediate destructive buttons.** Remove for an unused stored asset confirms like one in use (8.4, with a new string). Reset to Default and Use Built-in for All are quiet red only; a confirm or undo for them is a follow-up.
3. **The Reset message keeps its scope** (8.3): "Restore default settings, keeping keyboard shortcuts?".

---

## 17. Changelog against v3

| Area | v3 | Final | Why |
|---|---|---|---|
| Dark primary | Pale lavender `#d1d2e8` (L .87) | Periwinkle `#9d9fd6` (L .72), press `#b7b9ea`, ink `#232539` | Owner decision 1; deutan ΔE 2.0 → 17 from mint; less glare |
| Press | One opaque grey `#cbccdc` / `#5c5c82`, no ink change | Per-surface: `press` (light `#c1c1db`, dark `#66698b`), `ghost-press`, `band-press`, `chrome-press`; ink to `fg-strong`; sink; mint glow on raised faces | Press equalled hover on bands (ΔE 3.4); dark 1.30:1; light looked disabled; light press against mint was deutan 1.6; the owner allowed the glow, and it was compared and chosen |
| Chrome press | white/30 | Light black/18 (darkens), dark white/20 | A lighter step dims white ink to 4.0:1 on the mid-tone light chrome |
| Focus | Ring at the edge, `ring-inset ring-current` | Outline 2 px inside (offset −4), own ink; `focus-out` 1 px outside for faces under 32 px; edge rings for rows | It read as the control shrinking where ring and surround match (F4) |
| On-state | `shadow-latched` inset | Flat | The inset read as a blur at toolbar size; flat versus raised is the cue; inset now means pressed |
| ARIA styling | `.ghost[aria-pressed]`, `.ghost[aria-expanded]` generic | Opt-in `btn-toggle`; popup triggers or `.holds-open`; the uses listed | It would have painted checked Manager rows and toolbar value items mint (F5, plus the toolbar case found here) |
| Held transport | `btn-toggle` (on) | `.is-pressed` (press) | F2: a hold is a press. Same for the resize line being dragged |
| Mechanism | CSS imported by index.css | Tailwind plugin over `controls.css` | Scoped `<style>` blocks cannot `@apply` global CSS classes in Tailwind 3 (verified) |
| Checked rows | Retuned in C0, consumers in C4 | ManagerRow in C0; light `selected` `#a5e3d6`, `accent-strong` `#148074` | M1; v3 light tint was protan 1.5 against modal; drop ring 3.33:1 on its tint |
| Chrome tier | Dark values; danger 3.69:1 on light chrome | 255 205 199 / 255 218 124 / 190 227 255, all ≥ 4.5 on both | F7 |
| Dark warning, info | 255 214 111 / 175 218 255 (harness used 171 215 253) | = chrome tier | One set; the v3 prototype did not match its spec |
| Dark mint and dark danger text | Tuned (ΔE 1.8 and 1.9) | v0.5.22 values | Imperceptible tunes are not made |
| Guard | Class-string regex; `bg-accent` allowed | CSS rules and `theme()`; bare mint forbidden with a reasoned allowlist; per-package legacy lists of flagged files only; exact-line validation 172/172; focus loss and on-accent presses caught | Its first Don't could not fail (RC8) |
| Safety | Flagged only | ConfirmModal guard plus a shared `activationGuard.ts` | Owner decision 3 |
| Reset buttons | Quiet red; confirm open | Quiet red + ChoiceModal confirmation, two strings × 7 | Owner decision 4 |
| Unused stored-asset Remove | Immediate | Confirms, one string × 7; `StoredAssets.vue` to C0 | Owner decision, 2026-10-19 |
| Row focus | Edge ring in each row's own CSS | `focus-edge` recipe | The doc's exception and the guard's rule contradicted each other (final check) |
| Hover query | `(hover: hover)` | `(hover: hover) and (pointer: fine)`; on-toggle glow with one recipe class | Matches Tailwind's `hover:` output; compounds do not survive a merged `@apply` (final check) |
| Field invalid | None | `field[aria-invalid]` red edge | Recommended item; separates it from a focused quiet-destructive ring |
| Text | P2, P3 (20°), P4 (L .50), chrome accent 9.99, press "≈ .08 L" | P2 rewritten; 9° stated; light primary L .40; chrome accent 4.64 / 9.99 (mint unchanged); press steps tabled per surface; every rule has reasons and exceptions; "primary" covers a mode's commit | Critique §9.10 |
| Packages | By file; C4 owned ManagerRow; C3 owned SettingsModal | Exact, disjoint, script-checked; C0 owns the safety, Reset and ManagerRow; History is C8 with an element-keyed mapping | M1, M3, owner request |
