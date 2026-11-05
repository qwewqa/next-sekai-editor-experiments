# Legacy test deployment files

These bytes were copied before the gzip/Sonolus writer change. Do not regenerate them.
`SHA256SUMS` pins each file.

The baseline is `20f5883341e5410eb08611a65c4ba7ca631627e7`. At the time of copying,
`b67d7497` differed only in three production test files; its runtime and format writer
were identical to that deployment.

The two `write-*.nxsp` files are the existing deterministic builder goldens.
The other files were copied from `tests/native/fixtures/nxsp-v1/`, whose recorded
producer is `0.5.22+d6d6c401` and whose last regeneration commit is `3fe8a281`.
They are earlier v1 files that the deployment reads, not files it wrote. They cover full segmented history and current media, no history,
no media, metadata-only media and unticked BGM.
