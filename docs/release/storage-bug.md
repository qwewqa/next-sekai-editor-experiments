# When a release breaks storage

The steps for the maintainer when a release stops users from reaching their stored work, and the reply to post. Export Raw Data is in every build from v0.6.0 on, and it reads the database without the editor's record decoder, so it works when Recent Sessions and Save… do not.

## 1. When to use it

A release breaks storage: the editor does not start, sessions are missing, or Save or storing fails for many users.

## 2. First

Stop promoting the release and ship a forward fix: revert or repair the code and tag a new, higher patch. Never redeploy an old tag, since only the highest `v*` tag deploys. Never revert a database version raise, since a build that meets a newer database opens it read-only and stops storing.

## 3. What to tell users

Post this in the fix's release notes and in the issue thread. Replace `{version}` with the broken release and `{fixed}` with the fix.

> Version {version} has a bug that can stop the editor from starting or hide your sessions. To keep your work:
>
> 1. Do not clear this site’s data in your browser.
> 2. Open Settings › Local Data and choose Export Raw Data. Keep the ZIP file it downloads.
> 3. If the editor shows an error with an Export Raw Data button, choose it there.
> 4. If the editor does not start, open https://nse.qwewqa.dev/?safe and do step 2 there.
> 5. When version {fixed} is out, reload the page and look in History › Recent Sessions.
> 6. If your work is not there, email a private link to the ZIP file to nse@qwewqa.dev. Do not attach the file to a public issue. It contains your charts and audio.

## 4. What to ask for

- The ZIP file from Export Raw Data, as a private link by email.
- The version: Settings › About, or Copy Diagnostic Info….
- The browser and the operating system.
- What they did and what they saw: the text of the message, or a screenshot.
- Whether the editor opens with `?safe` added to the address.
- Whether they have project files (`.nxsp`) saved.
- Roughly when they last saw their work.

## 5. Loading a dump

1. Leave the ZIP as it is. Its first entry, `dump.json`, holds the rows and `localStorage`. Each stored file (media, recovered work, a preview package) is its own `blobs/<n>` entry, which a `$blobEntry` tag in `dump.json` names. To look at the data, check `dump.json`’s `format` (`nse-local-data-dump`), its `version` and its `appVersion`, the build that wrote it. A value JSON has no form for is tagged (`$num`, `$date`, `$typed`, `$other`). A stored file the export could not read is `{"$blobUnreadable": true, "type", "size"}` in `dump.json`, with no `blobs/` entry. The seeder writes an empty file of that type in its row, so it shows as not loaded or damaged.
2. Copy the ZIP itself into the nse-next `samples/` folder (or the folder `NSE_SAMPLES_DIR` names) as `<case>.zip`, for example `reporter-1.zip`. Never copy it into the repository. Case names use letters, digits, `.`, `_` and `-`.
3. Run `npm run dev` in a worktree at the broken release’s tag, to see what the user saw, or at the fix.
4. Open a fresh browser profile. The seeder refuses a database that holds any chain or session. A dump holds no file handles (the seeder leaves its handle rows out), so the first Save of a chain asks where to write.
5. Open `/?seedSample=<case>.zip` on the dev server. The page seeds the profile and reloads with the user’s data. The dump’s `journal.*` keys are seeded too and replay on that first load, so the profile is written to. The console says `[seedSample] Seeded <case>.zip; reloading.` A refusal says why, and the editor loads as usual.

## 6. Getting the work out

For each chain in History › Recent Sessions, open the row’s ⋯ menu and choose Save… there. That writes the chain’s latest state to a file without opening it. To look at a chain first, choose Restore Session, then Save.

Work the editor could not read is under Settings › Local Data: the unreadable recovered work and the journals of earlier visits, each with a Download button.

If the build cannot read a chain, fix the reader on a branch and load the dump again into a fresh profile. The seeder refuses the profile that was seeded already.

There is no `tools/recover.py`. It is deferred until a storage bug needs it.

## 7. Returning the files

Send the files back privately, as a link by email. Then delete the user’s ZIP, the copy in `samples/`, every other copy, and the browser profile you loaded it into. The privacy page says how such files are handled: they are used only to fix the problem and deleted when it is fixed.

## 8. Tried once

The steps above were tried on 2026-10-26, at commit `72311609` (branch `release-fixtures`), with the dev server on port 5597, `NSE_SAMPLES_DIR` set to a scratch folder and a fresh Chromium profile without the save picker, driven by a script.

- `tests/fixtures/web-storage-v1/raw-export.zip` (411 kB) is `dump.json` (1.56 MB) followed by five `blobs/<n>` entries: `format` `nse-local-data-dump`, `version` 1, `appVersion` `0.5.22+0d503931`, database `nse-local-data` version 1.
- The ZIP was copied unchanged to the scratch folder as `trial.zip`. `/?seedSample=trial.zip` seeded the profile, the console said `[seedSample] Seeded trial.zip; reloading.`, and the editor opened.
- History › Recent Sessions listed six chains: `fixture` (the one the editor continued, 544 notes), `fork.nxsp` (542), `no-history.nxsp` (27), `fork` (not saved to a file, 2), `no-media.nxsp` (1) and `Untitled` (0).
- Restore Session of `no-media.nxsp` opened it.
- ⋯ › Save… on `fork.nxsp` opened the Save Project File dialog (History 8 steps, 8.4 kB; BGM 48 kB; about 82.7 kB in all), and Save downloaded `fork (restored Nov 5).nxsp` (83,581 bytes). The editor’s reader opens it fully with an empty report and nine History entries (the eight steps and the Save).
