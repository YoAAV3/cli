import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { toAMLLLines } from "./amll-map.js";
import { fetchLRCLIB, interpolatePlaybackPosition, parseLyricsFile, parseSyncedLyrics, resolveLyrics, shapeLines } from "./data.js";

const originalFetch = globalThis.fetch;
const originalSpicetify = globalThis.Spicetify;
const track = {
  title: "Test Song",
  artist: "Test Artist",
  album: "Test Album",
  durationSec: 180,
  durationMs: 180000,
  uri: "spotify:track:test-track",
  trackId: "test-track",
};

const lyricsFile = `version: '1.0'
metadata:
  title: Test Song
  artist: Test Artist
lines:
  - text: "Hello world"
    start_ms: 1000
    end_ms: 3000
    words:
      - text: "Hello "
        start_ms: 1000
      - text: "world"
        start_ms: 1900
`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Spicetify = originalSpicetify;
});

test("parses validated LRCLIB word timestamps", () => {
  const [line] = parseLyricsFile(lyricsFile);
  assert.equal(line.text, "Hello world");
  assert.deepEqual(line.words, [
    { text: "Hello ", startMs: 1000, endMs: 1900 },
    { text: "world", startMs: 1900, endMs: 3000 },
  ]);
  const [amllLine] = toAMLLLines([line]);
  assert.equal(amllLine.words.map((word) => word.word).join(""), "Hello world");
});

test("rejects lyricsfile lines without consistent word-level timing", () => {
  const noWords = lyricsFile.replace(/    words:[\s\S]*$/, "");
  const mismatchedWords = lyricsFile.replace('"world"', '"there"');
  assert.equal(parseLyricsFile(noWords), null);
  assert.equal(parseLyricsFile(mismatchedWords), null);
});

test("ignores untimed blank separators in an otherwise word-timed LRCLIB file", () => {
  const withBlankLine = lyricsFile.replace(
    "  - text: \"Hello world\"",
    "  - text: \"\"\n    start_ms: 0\n    end_ms: 0\n  - text: \"Hello world\"",
  );
  assert.equal(parseLyricsFile(withBlankLine).length, 1);
});

test("parses LRCLIB synchronized LRC timestamps including blank lines and repeated time tags", () => {
  assert.deepEqual(parseSyncedLyrics("[00:01.25][00:02.50]First line\n[00:03.5]Second line\n"), [
    { startMs: 1250, text: "First line" },
    { startMs: 2500, text: "First line" },
    { startMs: 3500, text: "Second line" },
  ]);
});

test("line-synced lyrics end at the next provider timestamp without extending past it", () => {
  const [first, second] = shapeLines([
    { startMs: 1000, text: "First line" },
    { startMs: 1800, text: "Second line" },
  ], 5000);
  assert.equal(first.endMs, 1800);
  assert.equal(first.words.at(-1).endMs, 1800);
  assert.equal(second.endMs, 5000);
});

test("interpolates lyric playback between Spotify progress samples and clamps to duration", () => {
  assert.equal(interpolatePlaybackPosition(52000, 10000, 10500, true, 239000), 52500);
  assert.equal(interpolatePlaybackPosition(52000, 10000, 10500, false, 239000), 52000);
  assert.equal(interpolatePlaybackPosition(238900, 10000, 10500, true, 239000), 239000);
});

test("uses LRCLIB word timings before contacting Spotify", async () => {
  let spotifyRequested = false;
  globalThis.fetch = async (url) => {
    const request = new URL(String(url));
    const params = request.searchParams;
    assert.equal(request.origin, "https://lrclib.net");
    assert.equal(request.pathname, "/api/search");
    assert.equal(params.get("artist_name"), track.artist);
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          trackName: track.title,
          artistName: track.artist,
          duration: track.durationSec,
          lyricsfile: lyricsFile,
        },
      ],
    };
  };
  globalThis.Spicetify = {
    CosmosAsync: {
      get: async () => {
        spotifyRequested = true;
        throw new Error("Spotify should not be queried for valid LRCLIB word timing");
      },
    },
  };

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "lrclib");
  assert.equal(result.wordTiming, "real");
  assert.equal(result.lines[0].words.length, 2);
  assert.equal(spotifyRequested, false);
});

test("prefers the matching album and recording duration from LRCLIB search results", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        trackName: track.title,
        artistName: track.artist,
        albumName: "Test Song (Deluxe)",
        duration: 178,
        lyricsfile: lyricsFile.replace("Hello world", "Other words"),
      },
      {
        trackName: track.title,
        artistName: track.artist,
        albumName: track.album,
        duration: 181,
        lyricsfile: lyricsFile,
      },
    ],
  });

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "lrclib");
  assert.equal(result.lines[0].text, "Hello world");
});

test("prioritizes the exact album over a closer-duration alternate release", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        trackName: track.title,
        artistName: track.artist,
        albumName: "2018 Songs of the Year",
        duration: track.durationSec,
        lyricsfile: lyricsFile.replace("Hello world", "Alternate recording"),
      },
      {
        trackName: track.title,
        artistName: track.artist,
        albumName: track.album,
        duration: track.durationSec + 12,
        lyricsfile: lyricsFile,
      },
    ],
  });

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "lrclib");
  assert.equal(result.lines[0].text, "Hello world");
});

test("sends album and duration hints and rejects a different recording", async () => {
  globalThis.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    assert.equal(params.get("artist_name"), track.artist);
    assert.equal(params.get("track_name"), track.title);
    assert.equal(params.get("album_name"), track.album);
    assert.equal(params.get("duration"), String(track.durationSec));
    return {
      ok: true,
      status: 200,
      json: async () => [{
        trackName: track.title,
        artistName: track.artist,
        albumName: track.album,
        duration: track.durationSec + 45,
        lyricsfile: lyricsFile,
      }],
    };
  };

  const result = await fetchLRCLIB(track);
  assert.equal(result.lines, null);
});

test("falls back to Spotify when LRCLIB has no valid word timing", async () => {
  let spotifyRequested = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        trackName: track.title,
        artistName: track.artist,
        duration: track.durationSec,
        syncedLyrics: "[00:01.00]Hello world",
      },
    ],
  });
  globalThis.Spicetify = {
    CosmosAsync: {
      get: async (...args) => {
        assert.equal(args.length, 1);
        assert.match(args[0], /^https:\/\/spclient\.wg\.spotify\.com\/color-lyrics\/v2\/track\/test-track\?/);
        spotifyRequested = true;
        return {
          lyrics: {
            syncType: "LINE_SYNCED",
            lines: [{ startTimeMs: "1000", words: "Hello world" }],
          },
        };
      },
    },
  };

  const result = await resolveLyrics({ ...track, trackId: "" });
  assert.equal(spotifyRequested, true);
  assert.equal(result.provider, "spotify");
  assert.equal(result.wordTiming, "interpolated");
  assert.equal(result.lines[0].text, "Hello world");
});

test("shows Spotify unsynced lyrics instead of reporting none", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{
      trackName: track.title,
      artistName: track.artist,
      duration: track.durationSec,
      syncedLyrics: "[00:01.00]Hello world",
    }],
  });
  globalThis.Spicetify = {
    CosmosAsync: {
      get: async () => ({
        lyrics: {
          syncType: "UNSYNCED",
          lines: [{ words: "Hello world" }, { words: "Second line" }],
        },
      }),
    },
  };

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "spotify");
  assert.equal(result.syncType, "UNSYNCED");
  assert.deepEqual(result.lines.map((line) => line.text), ["Hello world", "Second line"]);
});

test("uses accurate Spotify syllable timestamps when provided", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{
      trackName: track.title,
      artistName: track.artist,
      duration: track.durationSec,
      syncedLyrics: "[00:01.00]Hello world",
    }],
  });
  globalThis.Spicetify = {
    CosmosAsync: {
      get: async () => ({
        lyrics: {
          syncType: "SYLLABLE_SYNCED",
          lines: [{
            startTimeMs: "1000",
            endTimeMs: "2100",
            words: "Hello world",
            syllables: [
              { text: "Hello ", startTimeMs: "1000", endTimeMs: "1500" },
              { text: "world", startTimeMs: "1500", endTimeMs: "2100" },
            ],
          }],
        },
      }),
    },
  };

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "spotify");
  assert.equal(result.syncType, "SYLLABLE_SYNCED");
  assert.equal(result.wordTiming, "real");
  assert.deepEqual(result.lines[0].words.map(({ startMs, endMs }) => [startMs, endMs]), [[1000, 1500], [1500, 2100]]);
});

test("uses LRCLIB synced lyrics when Spotify has no lyrics", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{
      trackName: track.title,
      artistName: track.artist,
      albumName: track.album,
      duration: track.durationSec,
      lyricsfile: "lines: []",
      syncedLyrics: "[00:01.00]Hello world\n[00:03.00]Second line",
    }],
  });
  globalThis.Spicetify = { CosmosAsync: { get: async () => { throw new Error("No Spotify lyrics"); } } };

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "lrclib");
  assert.equal(result.syncType, "LINE_SYNCED");
  assert.equal(result.lines[0].text, "Hello world");
});

test("uses LRCLIB plain lyrics when neither source returns synced lyrics", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{
      trackName: track.title,
      artistName: track.artist,
      albumName: track.album,
      duration: track.durationSec,
      plainLyrics: "First line\n\nSecond line",
    }],
  });
  globalThis.Spicetify = { CosmosAsync: { get: async () => { throw new Error("No Spotify lyrics"); } } };

  const result = await resolveLyrics(track);
  assert.equal(result.provider, "lrclib");
  assert.equal(result.syncType, "UNSYNCED");
  assert.deepEqual(result.lines.map((line) => line.text), ["First line", "Second line"]);
});
