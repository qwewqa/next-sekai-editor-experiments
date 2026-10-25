# Colour system

The roles, tokens and control recipes behind the editor's UI colour, and the rules that keep them consistent. The values and recipes live in `src/themes.css`, `tailwind.colors.js` and `src/controls.css`. A guard test (`tests/editor/colorRoles.test.ts`, section 9) enforces the rules.

- **Scope.** UI colour roles. Chart content keeps its own colours (section 10).
- **Related.** [design-language.md](design-language.md) covers surfaces, shape, size, the History surfaces, and waits and feedback; [ui-review-checklist.md](ui-review-checklist.md) is the review questions.

---

## 1. In one paragraph

Mint keeps one meaning: **something is on** (a switch, the tool in use, a mode in force, rows checked for an action, and the current marker on the dark chrome). **The primary action is ink:** indigo in light and periwinkle in dark, so action and on differ in lightness as well as hue. **Destructive is red in both themes:** a filled red for the action a destructive dialog exists for, and a quiet red label when it is offered beside a safe default. **Three elevations tell the state:** raised is pressable, flat is on, and sunk is being pressed. **A press is one step beyond hover:** the face takes one tone, the ink strengthens, it sinks, and a raised control keeps its mint glow, so a tap always shows and never looks like on or like disabled. **Focus is one rule:** a 2 px ring drawn 2 px inside the face, in the face's own ink. Warning and info are tokens with their glyphs. The neutrals, the surfaces, the white raised pills, the hover glow and the quick toast keep their v0.5.22 look.

---

## 2. Principles

Each principle gives its reason and its known exceptions. When one does not fit a case, depart from it and say why in review.

1. **Name a role, not a colour.** Components use role tokens (`primary`, `danger-fill`, `press`) through the recipes, never raw palette classes (`amber-300`) or literals in UI chrome.
   - *Reason:* a role can be retuned in one place, and the guard test can check its use.
   - *Exceptions:* chart content (section 10); shadows that are geometry rather than a role, such as the dock edge.

2. **Mint means on.** The tool in use, a switch that is on, Show Edits, Select while selecting, rows checked for an action and the peek ring are mint. The quick notice is mint too, as the brand's one transient voice.
   - *Reason:* it is the app's brand colour, and in v0.5.22 it was every on-state. Giving it one meaning lets a user read it at a glance.
   - *How the rest is shown:* single-select selection (the current row, the selected segment) is elevation, the raised pill. Current markers are mint only on the dark chrome, where mint has contrast (the rail tab bar); on light bands they are ink (the band tab marker, 4.97:1 against mint's 1.85:1). Thin mint marks on light surfaces use `accent-strong`.
   - *Exception:* the hover and press glow is mint. It is a shadow, never a fill, and it lasts only while pointed at or pressed, so it cannot read as on.

3. **Ink is the primary action.** A button is primary when it is the default that Enter presses, or the commit of a mode or form (Restore commits peek mode). A footer has at most one filled button, and it is the one Enter presses.
   - *Reason:* the safe path is the strongest, in line with the data-loss rule. The Enter target is obvious, and the primary cannot be mistaken for an on-state.
   - *Exception:* a destructive ConfirmModal fills its own action red, because that action is the one Enter presses (see 8.2).

4. **Red means destructive or failed. It is told apart by form.**
   - Destructive: a button or menu row naming the action, with a trash icon in menus.
   - Error: a text line with `role="alert"` and its glyph.
   - A destructive choice offered beside a safe default is quiet (a neutral pill with a red label) and fills red only when pressed.
   - *Reason:* both mean harm, so they share a hue; their form keeps them apart. Quiet labels keep a single filled button per footer.

5. **Status hues come with their glyphs.** Warning is amber with a triangle, and info is blue with a circle. There is no success hue (success is the quick notice).
   - *Reason:* amber and red are close for deuteranopia (light ΔE 1); the glyph and the words carry the meaning.
   - *Exception:* the change orange is drawn only on the chart, never in the UI (section 10).

6. **Roles that must differ, differ in lightness, not hue alone.** Check fill against fill, under colour-vision deficiency too, not only text against fill. Section 4.3 is the check.
   - *Reason:* about 1 man in 12 has a red-green deficiency, and a hue-only difference vanishes for him. That is why a pale lavender dark primary was rejected (deutan ΔE 2.0 from mint), and why the light press face is darker than the mint (deutan ΔE 1.6 at a lighter grey).
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
   - A raised face takes the `press` tone, its ink becomes `fg-strong`, it sinks, and it keeps its glow (8.1 gives the reasons).
   - A filled face steps its own fill.
   - A ghost takes a second tint step, the same size as its first.
   - *Reason:* a press must read as a touch on every surface, never as on or disabled. Disabled fades the ink; press strengthens it, and the glow shows it is live.
   - *Direction:* the step goes the way that keeps the label at 4.5:1. That is usually the same direction as hover and toward the label. The exceptions, each forced by contrast:
     - dark filled faces with dark ink (periwinkle, coral) lighten;
     - on the mid-tone light chrome, a press darkens (`chrome-press`), because a lighter step dims its white ink below 4.5:1.
   - *Classify by behaviour:* anything held under a finger, key or drag is a press, including the held transport step, the toolbar face a Quick Switch press holds, the flyout row under a press-drag and the resize line being dragged.

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

15. **A token retune lands with every consumer of that token.** When `selected` is retuned, for example, the ManagerRow tint that uses it is adjusted in the same change.

16. **Keep the feel.** The palette stays seven hues; no surface colour changes; the light `accent`, `danger` and surfaces are byte-identical to v0.5.22.

17. **Forced colours: basic function only** (low priority). The recipes keep the transparent resting outline that high contrast paints as an edge, and thicken focus to 4 px there. No other work.

---

## 3. Tokens

Values are RGB channel triples, as in `src/themes.css`. OKLCH is given as L C h.

These keep their v0.5.22 values (principle 16):

- the surfaces and inks: `fg`, `fg-strong`, `bg`, `scrim`, `button`, `header`, `header-hover`, `modal`, `popup`, `popup-hover`, `popup-edge`, `preview`, `knob`, `recess`, `band-hover`;
- `accent` and `on-accent` (the same in both themes);
- the light `danger` and `on-danger`, and the dark `danger`.

### 3.1 Role tokens

| Role | Token | Light | Dark | Used for |
|---|---|---|---|---|
| On; brand | `accent` | 119 239 220 `#77efdc` (.877 .112 182) | same | Tool in use, switch track on, Show Edits, Select on, snap on, rail marker, peek ring, quick notice |
| Ink on mint | `on-accent` | 48 51 77 `#30334d` | same | Glyphs and text on `accent` / `accent-press`; the switch knob when on |
| On, pressed | `accent-press` | 72 201 182 `#48c9b6` (.760) | same | Pressing something that is on |
| Thin mint marks | `accent-strong` | 20 128 116 `#148074` (.541 .092 183) | 119 239 220 (= accent) | Drop-target ring, current-and-checked ring, any thin mint mark on a light surface |
| Checked rows | `selected` | 165 227 214 `#a5e3d6` (.870 .065 180) | 40 85 90 `#28555a` (.420) | Rows checked for an action; the drop-target fill. Full strength, no `/40` |
| Primary | `primary` | 68 68 102 `#444466` (.402 .057 284), = fg | 157 159 214 `#9d9fd6` (.721 .080 283) periwinkle | The one primary button of a dialog, strip or form |
| Ink on primary | `on-primary` | 255 255 255 | 35 37 57 `#232539` | |
| Primary pressed | `primary-press` | 95 95 133 `#5f5f85` (.501) | 183 185 234 `#b7b9ea` (.801) | |
| Raised face pressed | `press` | 193 193 219 `#c1c1db` (.819 .036 286) | 102 105 139 `#66698b` (.531) | Every raised neutral control while pressed or held |
| Ghost pressed | `ghost-press` (alpha) | fg / 0.25 | fg / 0.20 | A ghost or menu row while pressed, over any panel or popup |
| Band pressed | `band-press` (alpha) | white / 0.8 | white / 0.2 | A ghost on a header band while pressed (`band-hover` is white/0.4 and /0.1) |
| Chrome pressed | `chrome-press` (alpha) | black / 0.18 | white / 0.2 | A ghost on the dark chrome while pressed |
| Destructive and error text | `danger` | 185 28 28 `#b91c1c` | 255 184 184 `#ffb8b8` | Quiet destructive labels, destructive menu rows, error lines |
| Destructive fill | `danger-fill` | 185 28 28 | 237 117 110 `#ed756e` (.700 .150 25) coral | The destructive confirm; a pressed quiet destructive; a pressed destructive menu row |
| Ink on destructive fill | `on-danger` | 255 255 255 | 35 37 57 | |
| Destructive pressed | `danger-press` | 205 72 64 `#cd4840` | 247 149 141 `#f7958d` | |
| Warning | `warning` | 146 91 12 `#925b0c` (.521 .110 68) | 255 218 124 `#ffda7c` (.900 .121 88) | Warning text and glyphs, always with the triangle |
| Info | `info` | 22 102 170 `#1666aa` (.501 .130 250) | 190 227 255 `#bee3ff` (.898 .055 241) | Info glyphs and text, always with the circle |
| Switch off track | `toggle-off` | 143 143 163 `#8f8fa3` | 117 120 151 `#757897` | ToggleSwitch when off |
| History changes | `change` | 255 155 66 `#ff9b42` | same | Defined but not read: the change marks use `CHANGE_COLOR` in `src/editor/canvas/changes.ts` (section 10) |

**Chrome tier.** The dark chrome over the chart (status bar, panel rail, toolbar row, elevation header, offscreen badges) is mid-tone in light and dark in dark. `.surface-chrome` on those roots sets status values that pass 4.5:1 on both (the offscreen badges use only white and do not carry it):

| Token | Value | On light chrome | On dark chrome |
|---|---|---|---|
| `danger` | 255 205 199 | 4.53 | 9.75 |
| `warning` | 255 218 124 | 4.77 | 10.25 |
| `info` | 190 227 255 | 4.78 | 10.29 |
| `accent-strong` | 119 239 220 | 4.64 | 9.99 |

`accent` is not overridden on the chrome. It is the same mint in both themes: 4.64:1 on the light chrome and 9.99:1 on the dark. White/80 text stays at 4.80 and 9.43.

`.surface-chrome` cascades to every descendant. Put it on roots whose descendants are all chrome, not on a root that also contains light faces or popups. The toolbar flyout (white faces on `popover`, inside the toolbar row's DOM) is the case to watch: under `.surface-chrome` its `accent-strong`, `danger` and `focus-out` would flip to the pale chrome values. Nothing in the flyout uses them. If a flyout face ever needs one of those roles, move the class inward to the chrome parts.

**Deliberate exception: the shown toolbar tool.** `LevelEditorToolbar.vue` puts `surface-chrome` on each shown tool, a white raised face over the chart. The toolbar row is listed as chrome, but its root is a transparent container that also holds the flyout, so the class cannot go there. The tool is the only element that carries it, and the class stays off the flyout (the flyout is a sibling, not a descendant). Nothing inside a tool face uses `danger`, `warning`, `info`, `accent-strong` or `focus-out`, so the class changes no colour there. If a tool face ever needs one of those roles, drop the class from the tool and set the role's chrome value on the face that needs it.

**Shadows** (`tailwind.colors.js` `boxShadow`, themes.css):

- `shadow-pressed`, the sink: light `inset 0 1px 3px rgb(48 51 77 / .35)`, dark `… rgb(0 0 0 / .5)`.
- The glow is the `shadow-md` geometry in mint, set by the recipes as `--glow`, and red (`danger-fill`) on destructive buttons.
- There is no latched shadow: the on-state is flat.

`index.html` `theme-color` stays `#77efdc`.

---

## 4. Contrast and distinction (computed from the source files)

WCAG 2 relative luminance. ΔE is OKLab ×100, where about 2 is the threshold of noticing. Colour-vision deficiency is simulated with Machado 2009 at severity 1.0 (p protan, d deutan, t tritan). The values come from `src/themes.css`.

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
| `warning` on `modal` / `button` / `popup` | 4.72 / 5.64 / 5.64 | 9.54 / 6.10 / 7.75 |
| `info` on `modal` / `button` / `popup` | 5.01 / 5.97 / 5.97 | 9.57 / 6.12 / 7.78 |

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
| primary vs on (mint) | 6.70; 50, 52, 48, 49 | 1.81; 22, 21, 17, 20 | Distinct in both themes, also for CVD. A pale lavender dark primary was deutan 2.0 |
| primary vs danger-fill | 1.43; 24, 12, 20, 27 | 1.13; 18, 15, 15, 22 | Hue and form; they never share a footer (one filled button) |
| primary vs secondary | 9.27; 60 | 3.28; 29 | Distinct |
| on vs secondary | 1.38; 17, 8, 13, 19 | 5.94; 47 | Light: the mint fill differs from white mainly in hue. The knob, the eye swap or flatness carries the state (principle 11) |
| press vs on | 1.27; 14, 11, **6**, 14 | 3.83; 37 | Distinct. The light press is darker than mint for this; at a lighter grey it was deutan 1.6 |
| press vs secondary rest | 1.76; 18 | 1.55; 10 | A clear step, plus the sink and the glow |
| on pressed vs on | 1.47; 12 | 1.47; 12 | Clear |
| danger label vs fg label | 1.43; 24, 12, 20, 27 | 1.23; 10, 10, 7, 12 | The quiet destructive pill reads red, also for CVD |
| checked row vs modal | 1.21; 10, 5, 7, 10 | 1.55; 12, 12, 10, 11 | The checkbox carries the state; the tint is support (a lighter tint was protan 1.5) |
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

The step from hover to press is at least ΔE 6.5 on every surface, and every raised press adds the sink and the glow. A step no larger than hover gives only ΔE 3.4 on light bands.

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
| Field problem | `danger` text under the field | Red, under the field; `role="alert"`, `aria-invalid` |
| Outcome in a dialog (a file that could not be read) | `fg` text with a severity glyph | The glyph; a live region (polite; the failed Remove is an alert) |
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

### 5.3 Restore and Back to Now

- **Restore** is undoable: `restoreEntry` pushes a `restore` entry, or nothing when it already matches. It is the commit of peek mode, so it is `btn-primary`.
- **Back to Now** is `btn-secondary`.
- In the strip, mint marks only the mode: the ring and Show Edits.

### 5.4 Selection

| What | How it is drawn |
|---|---|
| Current row in a single-select list (Manager, History, segments, asset rows) | `row-current` (raised pill) |
| Rows checked for an action | `row-checked`, at full strength, plus the checkbox |
| The current row while also checked | The raised pill plus a 2 px `accent-strong` inset ring |
| Drop target | `row-drop` |
| Go To current option | The trailing check and the edge ring while the list holds focus; no permanent fill (the option stays flat) |
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
- **Who does not:** toolbar value items keep their check, so they do not get `btn-toggle`. The tool's `aria-pressed` is `state.current`, and `state.current` is also true for a value in use.

### 5.6 Notices and status

- **Quick notice:** the mint pill for every quick notice, as in v0.5.22.
  - A failure of something the user asked for is a card with the error glyph, not a quick notice. design-language.md, section 9, says which notice fits and gives the one exception.
- **Notice cards** stay neutral surfaces: `bg-modal` with `ring-fg/10` in the pane, `bg-popup` with the popup outline and ring over a dialog. The card is the peek strip's surface, so there is no tint and no coloured edge.
  - Severity is a leading 16 px glyph (`SeverityIcon`) in `text-warning` (triangle), `text-danger` (circle with an exclamation mark) or `text-info` (circle with an i). It is the optional `severity` field on `Notice`, `NoticeLine` and `LoadNotice`, set where the notice is raised, and it has no text of its own. Contrast is the `warning`, `info` and `danger` pairs of 4.1 on `modal` (in the pane) and `popup` (over a dialog); a glyph needs 3.
  - The mapping rule:
    - error: what the user asked for did not happen;
    - warning: work is at risk or was affected, and the user should act or check;
    - info: worth knowing, with nothing at risk;
    - neutral (no `severity`, no glyph): a confirmation or a route back, such as Open History, Reopen, "Download started" and "Continued … from …".
  - Two start-up lines that could be read either way: "This session was deleted in another tab or window." is a warning (work was affected), and "Kept … as a separate session." is neutral, like "Continued … from the old auto save" (both forms of `migrated` are confirmations).
  - The glyph is a second cue. The message carries the meaning, and the live region reads only the text.
  - `SeverityIcon` also leads inline lines in a dialog that report an outcome, at 16 px: the Preview Assets chooser's file and server errors, the failed Remove and the note under a fallback row (error for what failed, warning for a fallback or for storage that cannot be reached), and the warning mark on a fallback's tab. The tab sits on the band, where the warning pair is 3.0:1, the floor for a glyph.
  - The card's action is `btn-secondary`, 36 px in normal weight on a single card (32 px on a start-up row).
- **Status bar:** the root gets `.surface-chrome`.
  - The not-stored label and the warning glyphs are `text-warning`; info glyphs are `text-info`.
  - Text stays white/80.
  - Chips are small faces, so they ring 1 px outside, in white.

### 5.7 Text fields

- `field` is raised, as a secondary button, and hovers with the glow. Focus is the inside ring.
- `aria-invalid="true"` adds a 2 px red ring at the edge. It is separate from the focus ring. That ring stays inside, in the field's ink, so a focused invalid field shows both.
- It also does not look like a focused quiet-destructive button, whose red ring sits 2 px inside a pill.
- The four `aria-invalid` sites are ExportModal, ServerBody, ScaleSelectionModal and SaveDialog.

### 5.8 Destructive buttons outside dialogs

- **Reset Settings, Reset Shortcuts and Remove for a stored preview asset:** a quiet red label (`btn-danger-quiet`) and a confirmation (8.3).
- **Reset to Default and Use Built-in for All** in Preview Assets: a quiet red label with no confirmation. Each rewrites every type's source in one press.

---

## 6. Recipes (`src/controls.css`)

### 6.1 Mechanism

The recipes are CSS in `src/controls.css`, wrapped in `@layer components`, and registered by a small Tailwind plugin. That way every build context can use them: templates (`class="btn btn-secondary"`), global CSS, the landing pages, and **Vue `<style>` blocks** (`@apply ghost`).

The plugin is required. In Tailwind 3 a `<style>` block cannot `@apply` a class defined in another CSS file, and ManagerRow, PreviewTransport, PanelRail and TimelineList all style their controls in scoped CSS. The plugin, `tailwind.controls.js`, parses `controls.css` with PostCSS and adds the rules of its `@layer` as components. A `<style>` block can then `@apply btn btn-secondary` and get the whole recipe, `:active` and `:focus-visible` rules included. A two-recipe merge (`@apply ghost btn-toggle`) has the limit below.

- Both `tailwind.config.js` and `tailwind.landing.config.js` add `plugins: [require('./tailwind.controls')]`.
- A running dev server picks up `controls.css` edits. Tailwind finds a config's dependencies by scanning its files for `require('...')` text. The plugin reads `controls.css` with `readFileSync`, so a comment in the plugin names `require('./src/controls.css')` for Tailwind to see. An edit then rebuilds the global CSS and every Vue `<style>` block that uses `@apply`, with no restart. Keep that line when changing the plugin. A dev server that serves a different checkout still needs a restart.
- Recipes set colour, elevation, state and focus only. Size and shape stay at the call site.
- **Compound recipe selectors do not carry through a merged `@apply`.** `.row-checked.row-current` becomes `.x.row-current` and `.row-checked.x`, and neither matches. Combine such classes at the call site. A rule that must hold in scoped CSS is written with one recipe class: the on-toggle hover glow is `.btn-toggle[aria-pressed='true']:hover:not(:active)`, not `.ghost.btn-toggle…`.
- **Hover sits under `(hover: hover) and (pointer: fine)`.** This is the query Tailwind's `hover:` emits under `hoverOnlyWhenSupported`. A device that reports hover with a coarse pointer therefore keeps no glow after a tap.

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
| `segment-choice` + `segment-face` | A segmented control: labels in a recessed track (`bg-recess shadow-track`), each holding a hidden `input.peer` radio and the `span.segment-face` that is its face. The checked face is the raised current pill (`button`, `shadow-md`); the label draws a transparent 1 px edge that high contrast paints. Size and padding are the call site's. Sibling selectors only, so it works without `:has()` (the label's edge rule is its own) | `button/50`; a checked face keeps `button` | `ghost-press` with `fg-strong`; a checked face `press` | Ring inside, 2 px in the face's ink, while the input has `:focus-visible` (`Highlight` in high contrast) | Set at the call site (40 %) |
| `row-select` | A selectable row: a label holding a hidden `input.peer`, radio or checkbox. A checked radio row is the raised current row (`button`, `shadow-md`); a checkbox row keeps only its mark. A transparent 2 px edge outline | `band-hover`; a checked radio row keeps `button` | `ghost-press` with `fg-strong`; a checked radio row `press` | Ring at the edge, `fg`, while the input has `:focus-visible` (`:focus-within` where `:has()` is missing) | Set at the call site (40 %) |
| `focus-out` | For faces under 32 px: the ring 1 px outside in `fg` (white inside `.surface-chrome`) | | | | |
| `holds-open` | Opt-in: hold the hover look while `aria-expanded='true'` | | | | |
| `surface-chrome` | The chrome tier (3.1) | | | | |

**Open triggers:**

- `.btn` and `.ghost` with `[aria-haspopup][aria-expanded='true']` (or `.holds-open`) hold their hover look, except while pressed.
- That covers Brush Add, change options (…), the Manager row and Recent Sessions row More buttons, the Manager bulk Move and More buttons and Go To (`aria-haspopup="dialog"`).
- Disclosures that should hold open, such as PreviewSettings, add `.holds-open`.

**Order inside the file matters** and is commented in it: rest, then the on-state, then hover, then open, then press, then the on-state's press. Equal-specificity rules therefore resolve press over hover and on over hover.

**Inner-face pattern.** When the painted face is a child of the focusable element, as in the History band tab pill or a field's value text, the parent's state steps the child with the same tokens:

- `.history-tab:active .history-tab-pill { @apply bg-band-press text-fg-strong }`;
- `.group:active .value { @apply text-fg-strong }`.

Prefer making the face the element.

### 6.3 Current uses of the attributes the recipes read

| Attribute | Where | Meaning | Recipe effect |
|---|---|---|---|
| `aria-pressed` | LevelEditorToolbarTool `pressed` = `state.current` | Tool, mode or open panel in use; **also a value in use** | Only tools, modes and panels add `btn-toggle`; values keep the check |
| | ChangeArrows Show Edits | On/off | `ghost btn-toggle` |
| | ManagerRow `.manager-name` | **Checked row** while selecting | None (not a toggle); the row takes `row-checked` |
| | ManagerRow `.manager-mode` | Select on | `ghost btn-toggle` |
| | ElevationEditor `.elevation-square` | Snap grid on | `btn btn-secondary btn-toggle` |
| `aria-haspopup` + `aria-expanded` | ChangeArrows options, BrushPropertiesFields Add, ManagerList bulk Move and More, ManagerRow More, RecentSessionsTab row More (`menu`); HistoryPanel Go To (`dialog`) | A popup is open | Holds the hover look |
| `aria-expanded` alone | TimelineList groups, ManagerRow folders, PropertiesPanel sections, PropertiesBlock, PanelRail tabs and toggle, PreviewTransport, toolbar groups | Disclosure | None, unless `.holds-open` (PreviewSettings only) |
| `aria-invalid` | ExportModal, ServerBody, ScaleSelectionModal, SaveDialog | Invalid field | `field` red edge |
| `.is-pressed` (class) | PreviewTransport held step, the toolbar face a Quick Switch press holds, toolbar flyout row under a press-drag | Held | The press look |

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

## 8. Press feedback and confirmations

### 8.1 Why a press keeps the glow

Three treatments were compared side by side, on a specimen of every control and in the dialog footers, in both themes, with touch (`:active` alone) and mouse presses:

1. neutral only: face step, stronger ink and sink;
2. neutral plus the mint glow;
3. the glow without the sink.

**Raised controls take the neutral press plus the glow.**

- **Dark theme.** Neutral alone is the weakest press there: label contrast caps the face step (1.55:1). The glow makes a tap unmistakable on the dark chart, the dark modal and the transport strip.
- **Light theme.** The glow removes the remaining disabled reading: disabled never glows, and a pressed face does.
- **On a mouse,** pressing keeps the hover's glow while the face drops a tone and sinks, so the press reads as more of the hover rather than as the glow switching off.
- **It cannot read as on.** The glow is a shadow and on is a flat mint fill. A pressed control also has a sunk, non-mint face (deutan ΔE 6 from mint in light).
- **The sink stays,** for a non-colour cue and for continuity with the inset `shadow-track` of recessed controls. Without it (variant 3) the look is nearly the same, so the cost is nil.
- **Ghosts do not glow:** they have no face or elevation, and a halo under a translucent tint looks like a smudge.

### 8.2 ConfirmModal: the accidental-activation guard

A held or doubled Enter must not confirm a destructive delete. Enter on a menu's Delete row opens the confirm on keydown with focus on Delete, so a held or repeated key reaches that button.

- ConfirmModal and ChoiceModal ignore activations within `GUARD_MS` (300 ms) of opening, and swallow key repeat on Enter and Space. Both call `useActivationGuard()` in `src/modals/activationGuard.ts`, the only place that defines `GUARD_MS`. Their buttons return early when `accidental()`, and their button rows take `@keydown.capture="onKeydown"`.
- ConfirmModal's focus on open stays on its action.
- The ×, Esc and outside presses stay unguarded, because closing is safe.
- `tests/browser/confirmDialog.spec.ts` checks that a held Enter and a doubled Enter (80 ms) do not confirm, that a fresh press after 300 ms does, and that focus on open is Delete.
- Other specs that confirm a Confirm or Choice dialog press through the guard with `confirmWhenReady` or `confirmKeyWhenReady` (`tests/browser/confirmWhenReady.ts`). A press inside the guard does nothing by design, so the helper presses again until the dialog has closed. It never waits a fixed time. A spec that tests the guard itself holds time with `page.clock`, as `confirmDialog.spec.ts` does.

### 8.3 Reset Settings, Reset Shortcuts and Remove: confirm with Cancel as the default

None of these can be undone. Remove deletes a stored preview asset whether or not a type uses it, and the user may not be able to load it again.

- Each opens ChoiceModal with its own label as the title and as the destructive button, and `cancelIsDefault: true`. Cancel is therefore primary, focused and rightmost, or on top when stacked on a phone, and a stray Enter cancels.
- ChoiceModal's guard (8.2) applies.
- ConfirmModal's focus on its action is for deletes that can be undone (5.2).
- No notice follows a reset.
- Reset Settings' message, "Restore default settings, keeping keyboard shortcuts?", says that shortcuts are kept, because touch users have no tooltip to say it.

---

## 9. The guard test

`tests/editor/colorRoles.test.ts` (node test, in `npm test`).

### 9.1 What it scans

- Every `src/**/*.{vue,ts,css}`, as text.
- Template and TS class strings and `@apply` lines are tokenised with their variant prefixes.
- CSS rules (in `.css` and `<style>` blocks) are parsed, so a rule's selector supplies the state for the `@apply`, `theme('colors.*')` and `var(--color-*)` uses in its body.
- Comments are stripped.

### 9.2 What it forbids outside `src/themes.css` and `src/controls.css`

| Rule | Catches | Reason |
|---|---|---|
| `press-is-mint` | Mint, or any `bg-`, `text-`, `fill-`, `ring-`, `border-` (and the other colour prefixes) `on-accent`, with or without an opacity, under any press variant (`active:`, `group-active:`, `peer-active:`, `has-[:active]:`, `enabled:active:`, `[.popup-item:enabled:active_&]:`), and any CSS rule whose selector is `:active`, `.is-held`, `.is-pressed` or `-pressed` (ignoring `:not(:active)`) with mint in its body | Press is never on |
| `mint-outside-recipes` | `bg-` / `text-` / `ring-` / `fill-` / `border-` / `outline-` / `shadow-` with `accent`, `accent-press`, `accent-strong` or `selected`; `theme('colors.accent' / 'on-accent' / 'selected')`; `var(--color-accent / on-accent / selected)` | On-states come from recipes; **bare `bg-accent` included** |
| `hover-glow-outside-recipes` | `shadow-accent` with any variant | The glow lives in `.btn` |
| `focus-colour` | A focus variant (`focus:`, `focus-visible:`, `focus-within:`, `group-focus-visible:` or `peer-focus-visible:`) with `ring-` / `outline-` in `fg`, `white`, `current`, `on-accent` or mint, and CSS `:focus` rules with mint | Focus comes from the recipes. Rows and menu rows use `focus-edge`. It carries no colour prefix, so it passes; `.popup-item` in `index.css` uses it |
| `focus-outline-none` | `outline-none` under any of those focus variants, such as `focus:outline-none` or `focus-visible:outline-none` (in a class string or `@apply`), in a non-exempt file | The recipe ring sits in the components layer, and a leftover `outline-none` of equal specificity in the later utilities layer removes it without any visible error |
| `danger-fill-outside-recipes` | `bg-danger` | `.btn-danger` / `danger-fill` |
| `raw-palette` | Tailwind palette colours (`amber-300`, `sky-300`, …) | Tokens |
| `colour-literal` | `bg-[#…]`, `text-[rgb(…)]` | Tokens |

### 9.3 Exemptions and allowances

**Exempt files** (chart content), each with its reason:

- `src/editor/canvas/**`
- `src/editor/minimap/paint.ts` (the minimap's chart drawing)
- the elevation canvas files (not `ElevationEditor.vue`)
- `src/preview/render*` and `usePreviewRendering.ts`
- `src/utils/colors.ts`
- `NoteShapeIcon.vue`
- `commands/bpm.ts` and `timeScale.ts`

**Allowed mint outside recipes.** Each entry is a file, a pattern the line must match, and a reason. An entry excuses only `mint-outside-recipes` and `hover-glow-outside-recipes`; the line still fails the other rules.

| File | Allowed | Reason |
|---|---|---|
| QuickNotice.vue | `colors.(on-)accent` | The quick notice |
| PanelRail.vue | `panel-tab-marker … bg-accent` | The current marker on the dark chrome |
| PeekBar.vue | `ring-accent` | Peek mode in force |
| PreviewSettings.vue | `shadow-accent` | Range thumbs take the hover glow and cannot take a class |

Adding to either list needs a reason in the entry.

A migration can exempt files it has not reached yet in lists named `tests/editor/colorRoles/legacy-C<n>.txt` or `legacy-C<n>-H<n>.txt`. The test reads them when the directory exists, and fails on a listed file that is already clean and on a violating file that is not listed. No such list exists now.

### 9.4 Fixtures

A unit test feeds one synthetic line per inventoried form through the detector and expects a hit. Each is a bare line, not a CSS rule: `bg-accent text-on-accent` in a class string, `active:`, `group-active:`, `peer-active:` and `has-[:active]:` with mint, `!bg-accent`, `@apply bg-accent text-on-accent`, `color: theme('colors.accent')`, `hover:shadow-accent`, `focus-visible:ring-white`, `focus-visible:outline-fg`, `focus-visible:outline-none`, `focus:outline-none`, `@apply focus-visible:outline-none`, `group-active:bg-on-accent/30`, `active:border-on-accent`, `active:ring-on-accent`, `text-amber-300` and `bg-[#fff]`. A second list must pass: the recipes (`btn btn-secondary`, `btn btn-primary focus-out`, `ghost ghost-band btn-toggle`, `row-checked row-current focus-edge`, `row-select`), `text-danger bg-danger-fill text-on-danger`, `bg-ghost-press text-fg-strong`, `active:bg-ghost-press`, `focus-visible:outline-offset-2`, `@apply bg-press text-fg-strong`, `text-warning text-info`, a plain `outline-none` and `bg-on-accent`. The test requires every snippet of the first list to hit and every snippet of the second to pass, so the check keeps working when no file in `src` violates a rule.

---

## 10. Out of scope: chart content and the change orange

Chart content keeps its own colours:

- notes, connectors, guides, grid and stages;
- the minimap's content and change ticks (its box and cursor are UI: white on `bg`, the box with a dark outer ring);
- the elevation canvas and the preview renderer;
- NoteShapeIcon;
- the BPM and time-scale chips;
- the `--note-accent` styles.

The change orange is chart content too: 4.50:1 and 7.18:1 on the chart. No UI element uses orange, so the marks stay the one hue nothing else on screen uses.

Light warning (h 68) and the change orange (h 59) are 9° apart, not 20°. They are told apart by lightness (L 0.52 against 0.78), and orange never appears on a UI surface. In dark they are 29° apart (h 88 against 59).

---

## 11. Risks and limits

- **`controls.css` reaches Tailwind through a plugin that reads it with `readFileSync`.** Tailwind rebuilds only for dependencies it can see, so the plugin names the file in a `require('./src/controls.css')` comment (6.1) and edits reach a running dev server. Check a long-lived server before you take screenshots all the same: probe a recently added recipe in the served `/src/index.css`.
- **Light theme, on against secondary,** differs mainly in hue (ΔE 17, protan 8). Form carries the state, as in v0.5.22.
- **Dark switch track off against the pill** is 1.92:1; the knob carries the state.
- **Light warning against danger** is deutan-confusable; the glyphs carry it.
- **The press glow is mint.** It is a shadow, it lasts only while held, and the pressed face is sunk and non-mint, so it does not read as on.
- **Scoped styles cannot merge two recipe classes into one compound selector** (6.1). The on-toggle hover glow is written with one class for that reason; `.row-checked.row-current` is combined at the call site.
- **`.surface-chrome` cascades** (3.1). A face inside the toolbar flyout that used `accent-strong`, `danger` or `focus-out` would take the chrome values.
