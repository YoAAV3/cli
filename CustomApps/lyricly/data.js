// Lyricly data layer (no UI framework; uses YAML parsing, fetch, and
// localStorage). Bundled with app.src.js into index.js — do
// not edit the bundle by hand.
//
// Chain: LRCLIB lyricsfile (real word timings) -> Spotify color-lyrics
// (line timings) -> null. In-memory LRU, no bulk.
// Normalized lines: [{text, startMs, endMs, words:[{text,startMs,endMs}],
// bg?}] with integer ms timings for AMLL.
import { parse as parseYaml } from "yaml";

const CACHE_LIMIT = 100;
const cache = new Map(); // track URI -> { lines, source }; in-memory only, no bulk storage
function cacheGet(k) {
	if (!cache.has(k)) return undefined;
	const v = cache.get(k);
	cache.delete(k);
	cache.set(k, v);
	return v;
}
function cacheSet(k, v) {
	if (cache.has(k)) cache.delete(k);
	cache.set(k, v);
	while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// Session tally so you can see how often real word-level timing shows up.
const sessionStats = { WORD_SYNCED: 0, SYLLABLE_SYNCED: 0, LINE_SYNCED: 0, UNSYNCED: 0, NONE: 0 };
function logSyncType(trackId, provider, syncType, wordTiming, reason) {
	try {
		if (sessionStats[syncType] !== undefined) sessionStats[syncType]++;
		else sessionStats.NONE++;
	} catch (e) {}
	try {
		console.info(
			"[lyricly] provider=" + provider +
			" syncType=" + syncType +
			" wordTiming=" + wordTiming +
			" track=" + trackId +
			(reason ? " reason=" + reason : "") +
			" session=" + JSON.stringify(sessionStats)
		);
	} catch (e) {}
}

function countSyllables(word) {
	// Vowel-group heuristic; interpolation weight only, never displayed.
	const w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
	if (!w) return 1;
	if (w.length <= 3) return 1;
	const groups = w.replace(/[^aeiouy]+/g, " ").trim().split(/\s+/).filter(Boolean);
	let n = groups.length || 1;
	if (w.endsWith("e") && n > 1) n--;
	return Math.max(1, n);
}

function interpolatePlaybackPosition(anchorProgress, anchorAt, now, isPlaying, durationMs = 0) {
	const elapsed = isPlaying && anchorAt > 0 ? Math.max(0, now - anchorAt) : 0;
	const position = Math.max(0, anchorProgress + elapsed);
	return durationMs > 0 ? Math.min(position, durationMs) : position;
}

async function fetchSpotifyLyrics(info) {
	// Fallback: color-lyrics straight from Spotify, by track ID, through
	// Spicetify.CosmosAsync (the client's own authenticated channel —
	// no manual Bearer token needed in here). Request carries the
	// documented app-platform header. Used when LRCLIB lacks real word timing.
	const trackId = info.trackId || trackIdFromUri(info.uri);
	if (!trackId) {
		console.warn("[lyricly] Spotify lyrics skipped: current item has no Spotify track ID.", info.uri);
		return null;
	}
	try {
		const body = await Spicetify.CosmosAsync.get(
			`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`
		);
		const lyrics = body && body.lyrics;
		if (!lyrics || !Array.isArray(lyrics.lines)) {
			console.info("[lyricly] Spotify returned no line-synced lyrics.", {
				trackId,
				syncType: lyrics && lyrics.syncType,
			});
			return null;
		}
		if (lyrics.syncType === "UNSYNCED") {
			const lines = lyrics.lines
				.map((line) => String(line.words || "").trim().replace(/\s+/g, " "))
				.filter(Boolean)
				.map((text) => ({ startMs: 0, endMs: 0, text, words: [] }));
			return lines.length ? { syncType: "UNSYNCED", lines } : null;
		}
		if (lyrics.syncType === "SYLLABLE_SYNCED") {
			const lines = lyrics.lines.map((line) => {
				const syllables = Array.isArray(line.syllables) ? line.syllables : [];
				const words = syllables.map((syllable) => {
					const startMs = Number(syllable.startTimeMs);
					const endMs = Number(syllable.endTimeMs);
					if (!syllable.text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
					return { text: String(syllable.text), startMs, endMs };
				});
				if (!words.length || words.some((word) => !word)) return null;
				const startMs = Number(line.startTimeMs);
				const endMs = Math.max(Number(line.endTimeMs) || 0, words[words.length - 1].endMs);
				return {
					startMs: Number.isFinite(startMs) ? startMs : words[0].startMs,
					endMs,
					text: String(line.words || words.map((word) => word.text).join("")).trim(),
					words,
				};
			}).filter(Boolean);
			return lines.length ? { syncType: "SYLLABLE_SYNCED", lines } : null;
		}
		if (lyrics.syncType !== "LINE_SYNCED") {
			console.info("[lyricly] Spotify lyric sync type is unsupported.", {
				trackId,
				syncType: lyrics.syncType,
			});
			return null;
		}
		const raw = lyrics.lines
			.map((l) => ({ startMs: Number(l.startTimeMs), text: String(l.words || "").trim().replace(/\s+/g, " ") }))
			.filter((l) => l.text && isFinite(l.startMs) && l.startMs >= 0);
		raw.sort((a, b) => a.startMs - b.startMs);
		if (!raw.length) {
			console.info("[lyricly] Spotify returned an empty line-synced lyric list.", trackId);
			return null;
		}
		return { syncType: "LINE_SYNCED", lines: raw };
	} catch (e) {
		console.warn("[lyricly] Spotify lyrics request failed.", e);
		return null;
	}
}

function shapeLines(raw, durationMs) {
	// raw: [{startMs, text}] sorted in. Assigns each line an end (next
	// line's start, else track duration, else start + 4s) and spreads its
	// words across the window weighted by syllable count — the honest
	// estimate that drives the word-by-word highlight.
	const lines = (raw || []).filter((l) => l && l.text && isFinite(l.startMs) && l.startMs >= 0);
	return lines.map((l, i) => {
		const fallback = durationMs > l.startMs ? durationMs : l.startMs + 4000;
		const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : 0;
		const end = nextStart > l.startMs ? nextStart : fallback;
		const endMs = Math.max(end, l.startMs + 1);
		const tokens = l.text.split(/\s+/).filter(Boolean);
		const weights = tokens.map((w) => Math.max(1, countSyllables(w)));
		const total = weights.reduce((a, b) => a + b, 0);
		const dur = Math.max(0, endMs - l.startMs);
		let t = l.startMs;
		const words = tokens.map((w, j) => {
			const last = j === tokens.length - 1;
			const d = last ? endMs - t : (dur * weights[j]) / total;
			const s = Math.round(t);
			t += d;
			return { text: w, startMs: s, endMs: Math.round(last ? endMs : t) };
		});
		return { startMs: l.startMs, endMs, text: l.text, words };
	});
}

function looksBg(text) {
	// Fully-parenthesized line, or a line OPENING with "(" that never
	// closes: "(ad-lib here)" / "(ooh yeah". Both are asides.
	const t = String(text || "").trim();
	return (t.length > 2 && t.startsWith("(") && t.endsWith(")")) ||
		(t.startsWith("(") && !t.includes(")"));
}

// Syllable-weighted word timing over a window (bg asides run ~2x fast).
// Mirrors shapeLines' pacing for split sub-lines. Pure + testable.
function splitWordsTimed(text, startMs, endMs, fast) {
	const rate = fast ? 45 : 90, minMs = fast ? 500 : 900;
	const tokens = String(text || "").split(/\s+/).filter(Boolean);
	const gap = Math.max(0, endMs - startMs - 400);
	const dur = Math.max(400, Math.min(Math.max(minMs, tokens.join(" ").length * rate), gap));
	const weights = tokens.map((w) => Math.max(1, countSyllables(w)));
	const total = weights.reduce((a, b) => a + b, 0) || 1;
	let t = startMs;
	const words = tokens.map((w, i) => {
		const last = i === tokens.length - 1;
		const d = last ? startMs + dur - t : (dur * weights[i]) / total;
		const s = Math.round(t);
		t += d;
		return { text: w, startMs: s, endMs: Math.round(last ? startMs + dur : t) };
	});
	if (words.length) words[words.length - 1].endMs = Math.round(endMs);
	return { words, sungEnd: Math.round(endMs) };
}

function markBgLines(lines) {
	// Parenthesized ad-libs/echoes become bg sub-lines: flagged, parens
	// stripped, tucked under the lead line by CSS. Shapes:
	//  1. full-line closed or not: "(swallow...)" / "(ooh yeah"
	//  2. trailing closed: "lead words (bg words)" -> split into lead +
	//     bg, each re-timed over its proportional share (bg fast rate)
	//  3. trailing UNCLOSED: "lead words (ooh yeah" -> same split
	// Mid-line asides ("Not (uh), from her") are handled per word below.
	const out = [];
	for (const l of lines || []) {
		const t = (l.text || "").trim();
		if (t.length > 1 && t.startsWith("(") && (t.endsWith(")") || !t.includes(")"))) {
			l.bg = true;
			l.text = t.replace(/^\(+/, "").replace(/\)+$/, "").trim() || t;
			if (l.words && l.words.length) {
				l.words[0].text = l.words[0].text.replace(/^\(+/, "");
				const last = l.words[l.words.length - 1];
				last.text = last.text.replace(/\)+$/, "");
			}
			out.push(l);
			continue;
		}
		const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(t);
		const li = t.lastIndexOf("(");
		const unclosed = li > 0 && !t.slice(li).includes(")") &&
			t.slice(0, li).trim() && t.slice(li + 1).trim();
		if ((m && m[1].trim() && m[2].trim() && l.startMs != null && l.endMs != null && l.endMs > l.startMs) ||
			(unclosed && l.startMs != null && l.endMs != null && l.endMs > l.startMs)) {
			const mainText = (m && m[1].trim()) || t.slice(0, li).trim();
			const bgText = (m && m[2].trim()) || t.slice(li + 1).trim();
			const total = mainText.length + bgText.length || 1;
			const split = l.startMs + ((l.endMs - l.startMs) * mainText.length) / total;
			const main = {
				text: mainText, startMs: l.startMs, endMs: Math.round(split),
				words: splitWordsTimed(mainText, l.startMs, split, false).words,
			};
			const bgTimed = splitWordsTimed(bgText, split, l.endMs, true);
			out.push(main, {
				text: bgText, startMs: Math.round(split), endMs: l.endMs,
				words: bgTimed.words, bg: true,
			});
			continue;
		}
		out.push(l);
	}
	try {
		const n = out.filter((l) => l.bg).length;
		if (n) console.info("[lyricly] bg-vocals: " + n + " sub-line(s)");
	} catch (e) {}
	// Mid-line asides keep exact timing position (no ambiguity) but render
	// small via word.bg. Lone bracket tokens are dropped (absolute word
	// timings shift nothing).
	for (const l of out) {
		if (!l.words) continue;
		const kept = [];
		for (const w of l.words) {
			if (/[()]/.test(w.text || "")) {
				w.text = String(w.text).replace(/[()]/g, "");
				if (!w.text) continue;
				w.bg = true;
			}
			kept.push(w);
		}
		l.words = kept;
		try { l.text = String(l.text).replace(/[()]/g, ""); } catch (e2) {}
	}
	return out;
}

function trackInfo() {
	try {
		const data = (Spicetify.Player && Spicetify.Player.data) || {};
		const item = data.item || {};
		const meta = item.metadata || {};
		const durationMs = Spicetify.Player.getDuration() || 0;
		return {
			title: meta.title || "",
			artist: meta.artist_name || meta.artist_title || "",
			album: meta.album_title || "",
			durationMs,
			durationSec: Math.round(durationMs / 1000),
			uri: item.uri || "",
			trackId: trackIdFromUri(item.uri || ""),
			art: meta.image_xlarge_url || meta.image_large_url || meta.image_url || "",
		};
	} catch (e) {
		return { title: "", artist: "", album: "", durationMs: 0, durationSec: 0, uri: "", trackId: "", art: "" };
	}
}

function trackIdFromUri(uri) {
	// "spotify:track:XXX" -> "XXX". Non-track URIs (episodes, ads) yield "".
	const parts = String(uri || "").split(":");
	return parts.length === 3 && parts[0] === "spotify" && parts[1] === "track" ? parts[2] : "";
}

function parseSyncedLyrics(text) {
	if (typeof text !== "string" || !text.trim()) return null;
	const lines = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const matches = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
		if (!matches.length) continue;
		const lyricText = rawLine.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, "").trim().replace(/\s+/g, " ");
		if (!lyricText) continue;
		for (const match of matches) {
			const fraction = match[3] || "0";
			const millis = fraction.length === 1 ? Number(fraction) * 100
				: fraction.length === 2 ? Number(fraction) * 10
					: Number(fraction.slice(0, 3));
			const startMs = (Number(match[1]) * 60 + Number(match[2])) * 1000 + millis;
			if (Number.isSafeInteger(startMs)) lines.push({ startMs, text: lyricText });
		}
	}
	lines.sort((a, b) => a.startMs - b.startMs);
	return lines.length ? lines : null;
}

function parseLyricsFile(text) {
	if (typeof text !== "string" || !text.trim()) return null;
	let document;
	try {
		document = parseYaml(text);
	} catch (e) {
		return null;
	}
	if (!document || !Array.isArray(document.lines) || !document.lines.length) return null;
	const numberMs = (value) => {
		if (value == null || (typeof value === "string" && !value.trim())) return null;
		const number = typeof value === "number" ? value : Number(value);
		return Number.isSafeInteger(number) ? number : null;
	};
	const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ");
	const lines = [];
	for (const entry of document.lines) {
		if (!entry || typeof entry.text !== "string") return null;
		if (!entry.text.trim() && (!Array.isArray(entry.words) || !entry.words.length)) continue;
		if (!Array.isArray(entry.words) || !entry.words.length) return null;
		const startMs = numberMs(entry.start_ms);
		const endMs = numberMs(entry.end_ms);
		if (startMs == null || endMs == null || endMs <= startMs) return null;
		if (lines.length && startMs < lines[lines.length - 1].startMs) return null;
		const words = entry.words.map((word) => {
			if (!word || typeof word.text !== "string" || !word.text) return null;
			const wordStartMs = numberMs(word.start_ms);
			if (wordStartMs == null) return null;
			return { text: word.text, startMs: wordStartMs, endMs: null };
		});
		if (words.some((word) => !word)) return null;
		const line = { text: entry.text, startMs, endMs, words };
		let assembled = "";
		for (let i = 0; i < words.length; i++) {
			const currentWord = words[i];
			if (currentWord.startMs < startMs || currentWord.startMs >= endMs) return null;
			if (i > 0 && currentWord.startMs <= words[i - 1].startMs) return null;
			currentWord.endMs = words[i + 1] ? words[i + 1].startMs : endMs;
			if (currentWord.endMs <= currentWord.startMs) return null;
			assembled += currentWord.text;
		}
		if (normalize(assembled) !== normalize(entry.text)) return null;
		lines.push(line);
	}
	return lines;
}

function normalizeTrackName(value) {
	return String(value || "").toLowerCase().normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

async function fetchLRCLIB(info) {
	const params = new URLSearchParams({
		artist_name: info.artist || "",
		track_name: info.title || "",
	});
	if (info.album) params.set("album_name", info.album);
	if (info.durationSec > 0) params.set("duration", String(info.durationSec));
	const controller = typeof AbortController === "undefined" ? null : new AbortController();
	const timer = setTimeout(() => {
		try { controller && controller.abort(); } catch (e) {}
	}, 2500);
	try {
		const res = await fetch(`https://lrclib.net/api/search?${params}`, {
			headers: { "x-user-agent": "lyricly-spicetify-app" },
			...(controller ? { signal: controller.signal } : {}),
		});
		if (!res.ok) {
			console.warn("[lyricly] LRCLIB search failed with HTTP " + res.status + ".");
			return { status: res.status, lines: null };
		}
		const body = await res.json();
		const expectedTitle = normalizeTrackName(info.title);
		const expectedArtist = normalizeTrackName(info.artist);
		const candidates = (Array.isArray(body) ? body : body ? [body] : [])
			.filter((entry) => entry && typeof entry === "object")
			.map((entry, index) => {
				const title = normalizeTrackName(entry.trackName || entry.track_name);
				const artist = normalizeTrackName(entry.artistName || entry.artist_name);
				const album = normalizeTrackName(entry.albumName || entry.album_name);
				const duration = entry.duration == null || entry.duration === "" ? NaN : Number(entry.duration);
				const difference = Number.isFinite(duration) && info.durationSec
					? Math.abs(duration - info.durationSec)
					: 0;
				const matchesTitle = title && expectedTitle && (title === expectedTitle || title.includes(expectedTitle) || expectedTitle.includes(title));
				const matchesArtist = artist && expectedArtist && (artist === expectedArtist || artist.includes(expectedArtist) || expectedArtist.includes(artist));
				const matchesAlbum = album && normalizeTrackName(info.album) && album === normalizeTrackName(info.album);
				const plausibleDuration = !info.durationSec || !Number.isFinite(duration) ||
					difference <= Math.max(12, info.durationSec * 0.06);
				return {
					entry,
					index,
					matchesTitle,
					matchesArtist,
					plausibleDuration,
					syncedLines: parseSyncedLyrics(entry.syncedLyrics),
					plainLines: typeof entry.plainLyrics === "string"
						? entry.plainLyrics.split(/\r?\n/).map((text) => text.trim()).filter(Boolean)
						: null,
					score: (title === expectedTitle ? 30 : matchesTitle ? 8 : 0) +
						(artist === expectedArtist ? 30 : matchesArtist ? 8 : 0) +
						(matchesAlbum ? 30 : 0) +
						(!Number.isFinite(duration) || !info.durationSec ? 0 :
							difference <= 2 ? 20 : difference <= 5 ? 14 : difference <= 12 ? 6 : 0),
				};
			})
			.filter((candidate) => candidate.matchesTitle && candidate.matchesArtist && candidate.plausibleDuration)
			.sort((a, b) => b.score - a.score || a.index - b.index);

		let instrumental = false;
		let syncedLines = null;
		let plainLines = null;
		for (const { entry, syncedLines: candidateSyncedLines, plainLines: candidatePlainLines } of candidates) {
			if (!syncedLines && candidateSyncedLines) syncedLines = candidateSyncedLines;
			if (!plainLines && candidatePlainLines && candidatePlainLines.length) plainLines = candidatePlainLines;
			if (entry.instrumental) {
				instrumental = true;
				continue;
			}
			const lines = parseLyricsFile(entry.lyricsfile);
			if (lines && lines.length) return { status: 200, lines, wordTiming: "real" };
		}
		if (!syncedLines && !plainLines && !instrumental) {
			console.info("[lyricly] LRCLIB matched no usable word-timed, synced, or plain lyrics.", {
				title: info.title,
				artist: info.artist,
				matches: candidates.length,
			});
		}
		if (instrumental && !syncedLines && !plainLines) return { status: 200, instrumental: true, lines: null };
		return { status: 200, lines: null, syncedLines, plainLines };
	} finally {
		clearTimeout(timer);
	}
}

async function resolveLyrics(info) {
	// Prefer verified, native LRCLIB word timing. If it is missing or
	// malformed, fall back to Spotify's authenticated line-synced endpoint.
	// Returns { provider, syncType, wordTiming, lines, trackId } or null.
	let instrumental = false;
	let lrclibSyncedLines = null;
	let lrclibPlainLines = null;
	try {
		const lr = await fetchLRCLIB(info);
		if (lr && lr.instrumental) {
			instrumental = true;
		}
		if (lr && lr.syncedLines) lrclibSyncedLines = lr.syncedLines;
		if (lr && lr.plainLines) lrclibPlainLines = lr.plainLines;
		if (lr && lr.lines && lr.lines.length) {
			logSyncType(info.trackId || info.uri, "lrclib", "WORD_SYNCED", "real", null);
			return {
				provider: "lrclib",
				syncType: "WORD_SYNCED",
				wordTiming: "real",
				lines: lr.lines,
				trackId: info.trackId || info.uri,
			};
		}
	} catch (e) {
		console.warn("[lyricly] LRCLIB request failed; falling back to Spotify lyrics.", e);
	}

	try {
		const spotify = await fetchSpotifyLyrics(info);
		if (spotify && spotify.syncType === "UNSYNCED") {
			const pack = {
				provider: "spotify",
				syncType: "UNSYNCED",
				wordTiming: "none",
				lines: spotify.lines,
				trackId: info.trackId || trackIdFromUri(info.uri),
			};
			logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "Spotify supplied unsynced lyrics");
			return pack;
		}
		if (spotify && spotify.syncType === "SYLLABLE_SYNCED" && spotify.lines.length) {
			const pack = {
				provider: "spotify",
				syncType: "SYLLABLE_SYNCED",
				wordTiming: "real",
				lines: spotify.lines,
				trackId: info.trackId || trackIdFromUri(info.uri),
			};
			logSyncType(pack.trackId, pack.provider, pack.syncType, "syllable", "Spotify supplied syllable timestamps");
			return pack;
		}
		if (spotify && spotify.lines) {
			const lines = markBgLines(shapeLines(spotify.lines, info.durationMs));
			if (lines.length) {
				const pack = {
					provider: "spotify",
					syncType: "LINE_SYNCED",
					wordTiming: "interpolated",
					lines,
					trackId: info.trackId || trackIdFromUri(info.uri),
				};
				logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "LRCLIB word timing unavailable");
				return pack;
			}
		}
	} catch (e) {
		console.warn("[lyricly] Spotify lyrics fallback failed.", e);
	}

	if (lrclibSyncedLines) {
		const lines = markBgLines(shapeLines(lrclibSyncedLines, info.durationMs));
		if (lines.length) {
			const pack = {
				provider: "lrclib",
				syncType: "LINE_SYNCED",
				wordTiming: "interpolated",
				lines,
				trackId: info.trackId || trackIdFromUri(info.uri),
			};
			logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "LRCLIB word timing unavailable; using synced lyrics after Spotify");
			return pack;
		}
	}
	if (lrclibPlainLines) {
		const pack = {
			provider: "lrclib",
			syncType: "UNSYNCED",
			wordTiming: "none",
			lines: lrclibPlainLines.map((text) => ({ startMs: 0, endMs: 0, text, words: [] })),
			trackId: info.trackId || trackIdFromUri(info.uri),
		};
		logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "using LRCLIB plain lyrics after Spotify");
		return pack;
	}

	if (instrumental) {
		logSyncType(info.trackId || info.uri, "lrclib", "UNSYNCED", "none", "instrumental; Spotify had no synced lyrics");
		return { provider: "lrclib", syncType: "UNSYNCED", wordTiming: "none", lines: [], trackId: info.trackId || info.uri, instrumental: true };
	}
	logSyncType(info.trackId || info.uri, "none", "UNSYNCED", "none", "no lyrics");
	return null;
}

export {
	CACHE_LIMIT, cacheGet, cacheSet, sessionStats, logSyncType,
	countSyllables, interpolatePlaybackPosition, fetchSpotifyLyrics, shapeLines,
	looksBg, splitWordsTimed, markBgLines, trackInfo, trackIdFromUri,
	parseSyncedLyrics, parseLyricsFile, fetchLRCLIB, resolveLyrics,
};
