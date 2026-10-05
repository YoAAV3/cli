# Lyricly

Lyricly prefers LRCLIB's `lyricsfile` data when every lyric line has
valid word timestamps. The YAML is parsed and checked for monotonic timing
and matching line/word text before it is passed to the lyric renderer. If the
file is missing or fails validation, Lyricly falls back to Spotify's
authenticated lyrics endpoint. Spotify line-, syllable-, and unsynced
responses are handled; LRCLIB synchronized LRC and plain text are last-resort
fallbacks if Spotify provides no lyric data. LRCLIB search includes album and
duration hints and rejects likely alternate recordings before considering
their word timings.

The fullscreen control moves Lyricly into a temporary overlay attached to the
document body before requesting fullscreen. This escapes Spotify's transformed
layout so its navigation, sidebars, and player bars cannot remain around the
lyrics. The overlay adds live transport, seeking, and volume controls, then
restores the app to its original location when fullscreen ends.

The in-memory LRU cache avoids repeat requests during a Spotify session.
`data.test.js` covers word-file validation and the Spotify fallback. Run
`pnpm test:lyricly` for those tests and `pnpm build:lyricly` to regenerate
the app bundle from `app.src.js` and `data.js`.

Lyrics Plus promotes LRCLIB to the first provider on the next startup after
this update. That one-time migration preserves subsequent manual provider
reordering.
