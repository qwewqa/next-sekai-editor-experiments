# Writing

These rules cover everything we write: the text users see, the maintainer docs (`README.md`, `CONTRIBUTING.md` and `docs/`), code comments, commit messages and the release notes. The first part applies to all of it. The second part adds the rules for user-facing text.

## Everything we write

- Write terse, plain text.
- Choose the word that is idiomatic in the register. The app uses plain software English, neither literary nor bureaucratic. The docs and comments use plain technical English.
  - A file contains something, and a feature requires something.
  - When unsure, follow the existing text, then common software usage.
- Leave out what the reader can assume.
- Give extra information its own sentence, not a ", which …" tail.
- Within a document, refer to the writer and the reader the same way throughout, such as "we" and "you".
- In code, comments, test titles, messages only developers see and commit messages, use ASCII quotes, apostrophes and operators, and name a command without its ellipsis. Keep other characters only where the text quotes the UI or the data needs them.
- Reword existing text only when the new wording is clearer or more accurate.

### Easy to read

These slow a reader down. Avoid them:

- **Things that act like people:** "storage did not answer". Use the plain verb: "returned an error", "could not be read".
- **Three or more nouns in a row:** "storage quota warning threshold". Use a preposition or a verb: "the warning when storage is almost full". Established names such as Level Info are fine.
- **Verbs made from nouns on the spot,** such as "surface" or "bucket". Use the ordinary verb.
- **A missing "that" when the clause has a long subject:** write "parts that this version of the editor does not support". After "you", the short form is fine: "items you load".
- **Unusual word pairs:** "returned an error", not "answered with an error".
- **Related words far apart:** keep a subject near its verb, with no clauses nested between them.
- **Padding:**
  - reassurance ("your work is safe");
  - "simply" and "just";
  - "not X but Y";
  - a sentence that repeats the heading or bold label before it;
  - colons or dashes that join two sentences.

## User-facing text

These rules apply only to user-facing text: the strings in `src/i18n/`, Help, notices, the release notes in `CHANGELOG.md`, the privacy page and docs written for users, such as `docs/usage-statistics.md`. That text follows the first part as well.

- Use no contractions, and ’ for apostrophes.
- Buttons, command names, setting names and their choices are Title Case.
- A label ends with an ellipsis when its action waits for the user’s answer before it happens: a value or a name (Scale Beats…, Save As…), a file (Choose…) or a confirmation (Delete Selected…). A confirmation that appears only in some cases, such as New’s when the chart has unsaved changes, does not count. A label that opens a window or a panel (Settings, Level Info, History) takes none, because the window is the result. The ellipsis tells the user that a question comes first. It would lose that meaning if every window had one. A dialog title drops it.
- When running text names a command, leave out its ellipsis and end the sentence with its own full stop. Keep the ellipsis only when the name is itself the clickable label.
- Put session names in quotes: “ ” in English, and each locale’s usual marks in the others. Put a file name in quotes only when it is the subject or starts the sentence: "Saved to coconut.nxsp", but "“coconut.nxsp” could not be written."
- Change all seven locales (`en`, `fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit, and reuse each locale’s existing terms.
- "Saved" means saved as a project file, and "unsaved" means not saved as one. Work kept only in this browser, such as Recent Sessions and the Timeline, is "stored" or "kept", never "saved". An export does not save.
- Say what happened and what to do, in words the user already knows.
  - Leave out internal terms such as chain, journal, worker, binding and slot. The maintainer docs may name them.
  - History lines say "Timeline steps", so they cannot be read as chart content being lost.
- Leave out what an action obviously does, and what does not happen.
- Reuse an existing phrasing ("could not be read", "Save to keep your work.") rather than writing a new one.
- Put a hint or note under a control only when it tells the user something they cannot learn from the label or by using the control, and they need it at that moment. Examples: a warning before data is lost, a privacy disclosure, a unit, the reason a control is unavailable.
- Give a setting a description, behind its info button, when its label and choices leave something unclear: a term (Render Scale, Antialiasing), the difference between its choices (Beat and Measure), a condition or limit (Show Stage Name, Max Scroll X), or where the effect shows (the current group, playback). Leave it out when it would only repeat the label and choices. A setting with a visible note has no description. Buttons, links and shortcut rows have none.
- Give every chart property a description, behind its info button: in the Properties panel, in the tools' settings, in Group Properties and Stage Properties, and for Initial Life in Level Info. Brush and View have none. The tool options among the properties, such as Copy Properties, have one too. A property's description says what its label cannot: what it does in play, its unit or range, what each choice does, or a limit. If it would only repeat the label, find the fact that the author needs.
- Write a description as you would explain it to the person using the editor, clearly and naturally. Keep it to its setting or property and their choices, and leave out how to use other parts of the editor.
  - Say what the setting or property does, with it as the subject: "Shows objects in other groups, faded", not "Objects in other groups appear faded".
  - Describe directions and positions as the user sees them. Give a caveat that matters its own sentence, and leave out an exception the user would not act on, but never write anything false.
  - When a select's choices do different things, give a brief introduction, then one line per choice. The editor puts the choice's name before its line, so the line does not repeat it.
  - Use prose for a select whose choices are groups, stages or presets, and for one whose choice names already say what differs, as colors, sounds, flick directions and ease curves do. Toggles and number fields use prose too.
- Label related controls the same way: if one has a suffix, its neighbours have one too, or none does. In each locale, put a name in the same place across related messages: "Added group {0}", "Deleted group {0}".

### Help

- Open a command entry with what the command does, in the present tense, with the command as the implied subject: "Mirrors the selection around lane 0." Never open with "Choose X to …", a condition, a secondary gesture or a side fact.
- A tool used through one main gesture may open with that gesture when it says the result in plain words: "Tap an object to erase it." A gesture such as "apply the brush" does not explain the result, so the entry needs a first line that does.
- In an entry for several commands, give each command a line in heading order, with its name as the subject. Commands that work alike share a line: "Previous Group and Next Group …". Put a line for one command after that command's line, and lines for several commands after all their command lines.
- Put a gesture's action first, then "to" and the result: "Drag a box to select the objects in it." Put a condition or held key first when there is one: "When the Properties panel is shown, tap …", "Hold Shift to …". Choosing a command again reads "Choose X again to …". Tap and click forms differ only in gesture words and mouse-only extras, such as the wheel.
- When pointing to a setting or another place, put the goal first: "To change the tools on the toolbar, open Settings › Toolbar."
- After the gestures, give at most two facts that an author needs and would not assume. Leave out edge cases the author would not act on, explanations of familiar game terms, and what another entry already says for the same tool. Keep every claim accurate.
- Write Controls as gestures and pointers in the same forms. Each line is one gesture, or a pair that belong together.
- Keep an entry for one command to at most five lines. An entry for several commands has one more line for each command line it needs.
