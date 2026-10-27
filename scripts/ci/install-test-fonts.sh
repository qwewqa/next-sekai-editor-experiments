#!/bin/sh
# Test-only: makes the browsers in the Linux CI container draw the sans-serif stack in Selawik (tests/fonts/README.md).
set -eu
mkdir -p "$HOME/.local/share/fonts/selawik" "$HOME/.config/fontconfig"
cp tests/fonts/selawik/*.ttf "$HOME/.local/share/fonts/selawik/"
cp tests/fonts/fonts.conf "$HOME/.config/fontconfig/fonts.conf"
fc-cache -f
for family in system-ui ui-sans-serif sans-serif sans Arial; do
    printf '%s -> ' "$family"
    fc-match -f '%{family} %{style}\n' "$family:bold"
done
case "$(fc-match -f '%{family}' sans-serif)" in
    Selawik*) ;;
    *) echo 'sans-serif does not resolve to Selawik' >&2; exit 1 ;;
esac
