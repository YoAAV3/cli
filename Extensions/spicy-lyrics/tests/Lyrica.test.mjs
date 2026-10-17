import { afterEach, expect, test } from "bun:test";

import {
  FetchLyricaLyrics,
  LYRICA_SOURCE_SEQUENCE,
  normalizeLyricaResponse,
} from "../src/utils/Lyrics/Lyrica.ts";

test("normalizes timestamped Lyrica lines for Spicy Lyrics", () => {
  const lyrics = normalizeLyricaResponse({
    status: "success",
    data: {
      source: "apple-music",
      timed_lyrics: [
        { text: "Second line", start_time: 2000, end_time: 3000 },
        { text: "First line", start_time: 1000, end_time: 2000 },
      ],
    },
  });

  expect(lyrics?.Type).toBe("Line");
  expect(lyrics?.provider).toBe("lyrica");
  expect(lyrics?.source).toBe("apple-music");
  expect(lyrics?.Content?.map((line) => ("Text" in line ? line.Text : ""))).toEqual(["First line", "Second line"]);
});

test("fills missing line end times from the next line or a short fallback", () => {
  const lyrics = normalizeLyricaResponse({
    status: "success",
    data: {
      timed_lyrics: [
        { text: "First line", start_time: 1000 },
        { text: "Last line", start_time: 3000 },
      ],
    },
  });

  expect(lyrics?.Content?.map((line) => ("EndTime" in line ? line.EndTime : 0))).toEqual([3000, 7000]);
});

test("uses word timings when Lyrica identifies word synchronization", () => {
  const lyrics = normalizeLyricaResponse({
    status: "success",
    data: {
      sync_level: "word",
      timed_lyrics: [
        {
          text: "Hello world",
          start_time: 0,
          end_time: 2000,
          words: [
            { text: "Hello", start: 0, end: 900 },
            { text: "world", start: 1000, end: 2000 },
          ],
        },
      ],
    },
  });

  expect(lyrics?.Type).toBe("Syllable");
  expect(lyrics?.Content?.[0] && "Lead" in lyrics.Content[0] ? lyrics.Content[0].Lead.Syllables.map((word) => word.Text) : []).toEqual([
    "Hello",
    "world",
  ]);
});

test("uses static lyrics when Lyrica has no timed lines", () => {
  const lyrics = normalizeLyricaResponse({
    status: "success",
    data: { lyrics: "First line\n\nSecond line" },
  });

  expect(lyrics?.Type).toBe("Static");
  expect(lyrics?.Lines?.map((line) => line.Text)).toEqual(["First line", "Second line"]);
});

test("rejects unsuccessful or empty Lyrica responses", () => {
  expect(normalizeLyricaResponse({ status: "error", data: { lyrics: "untrusted" } })).toBeNull();
  expect(normalizeLyricaResponse({ status: "success", data: {} })).toBeNull();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("queries Lyrica with only the configured provider sequence", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(
      JSON.stringify({
        status: "success",
        data: { timed_lyrics: [{ text: "Only Lyrica", start_time: 0, end_time: 1000 }] },
      }),
      { status: 200 },
    );
  };

  const result = await FetchLyricaLyrics("Song", "Artist");
  const url = new URL(requestedUrl);
  expect(url.searchParams.get("sequence")).toBe(LYRICA_SOURCE_SEQUENCE);
  expect(url.searchParams.get("pass")).toBe("true");
  expect(url.searchParams.get("song")).toBe("Song");
  expect(result.lyrics?.provider).toBe("lyrica");
});
