# Test fonts

Selawik 1.01 (Regular, Semibold and Bold), from <https://github.com/microsoft/Selawik>, under the SIL Open Font
License 1.1 (`selawik/OFL.txt`). It is made to match the metrics of Segoe UI, the font the app shows on the
Windows development machines, so a layout test sees the same text widths on Linux CI.

The fonts are for tests only. They are never bundled, so they are not in `THIRD_PARTY_NOTICES`.

`fonts.conf` points the sans-serif families at Selawik. `scripts/ci/install-test-fonts.sh` installs both into the
home of the CI container user. Nothing changes on a development machine.
