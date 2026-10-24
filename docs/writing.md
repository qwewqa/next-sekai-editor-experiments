# Writing user-facing text

This covers the strings in `src/i18n/`, Help, notices, the release notes in `CHANGELOG.md` and the privacy page.

## Rules

- Write terse, plain text. Use no contractions, and ’ for apostrophes.
- Buttons and command names are Title Case. A command that asks for more before it acts ends with an ellipsis.
- Put session names in double quotes. Put a file name in double quotes only when it is the subject or starts the sentence: "Saved to coconut.nxsp", but ""coconut.nxsp" could not be written."
- Change all seven locales (`en`, `fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit, and reuse each locale’s existing terms.
- Say what happened and what to do, in words the user already knows.
  - Leave out internal terms such as chain, journal, worker, binding and slot.
  - History lines say "Timeline steps", so they cannot be read as chart content being lost.
- Leave out what the user can assume: what an action obviously does, and what does not happen.
- Reuse an existing phrasing ("could not be read", "Save to a file to keep your work.") rather than writing a new one.
- Choose the word that is idiomatic in the app’s register: plain software English, neither literary nor bureaucratic.
  - A file contains something, and a feature requires something.
  - When unsure, follow the app’s existing strings, then common software usage.
- Give extra information its own sentence, not a ", which …" tail.

## Easy to read

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
  - colons or dashes that join two sentences.
