// Lyricly data layer (framework-free: only Spicetify globals at runtime,
// fetch, and localStorage). Bundled with app.src.js into index.js — do
// not edit the bundle by hand.
//
// Chain: Spotify color-lyrics (track ID, CosmosAsync) -> LRCLIB
// (track/artist/duration, no key) -> null. In-memory LRU, no bulk.
// Normalized lines: [{text, startMs, endMs, words:[{text,startMs,endMs}],
// bg?}] with integer ms timings for AMLL.

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
const sessionStats = { SYLLABLE_SYNCED: 0, LINE_SYNCED: 0, UNSYNCED: 0, NONE: 0 };
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

function parseLRC(text) {
	// Returns [{startMs, text}]. Handles [mm:ss.xx], multiple tags/line,
	// skips metadata tags ([ar:], [ti:], [length:], ...).
	const out = [];
	const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
	for (const raw of String(text || "").split("\n")) {
		const tags = [...raw.matchAll(re)];
		if (!tags.length) continue;
		const lyric = raw.replace(re, "").trim();
		if (!lyric) continue;
		for (const m of tags) {
			const frac = m[2].includes(".")
				? parseFloat("0." + m[2].split(".")[1].padEnd(3, "0").slice(0, 3))
				: 0;
			const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac;
			if (isFinite(sec) && sec >= 0) out.push({ startMs: Math.round(sec * 1000), text: lyric });
		}
	}
	out.sort((a, b) => a.startMs - b.startMs);
	return out;
}

async function fetchSpotifyLyrics(info) {
	// Primary: color-lyrics straight from Spotify, by track ID, through
	// Spicetify.CosmosAsync (the client's own authenticated channel —
	// no manual Bearer token needed in here). Request carries the
	// documented app-platform header. Synced lines win; anything else
	// (error, empty, unsynced-only) falls through to the LRCLIB backup.
	if (!info.trackId) return null;
	try {
		const body = await Spicetify.CosmosAsync.get(
			`https://spclient.wg.spotify.com/color-lyrics/v2/track/${info.trackId}?format=json&vocalRemoval=false&market=from_token`,
			null,
			{ "app-platform": "WebPlayer" }
		);
		const lyrics = body && body.lyrics;
		if (!lyrics || lyrics.syncType !== "LINE_SYNCED" || !Array.isArray(lyrics.lines)) return null;
		const raw = lyrics.lines
			.map((l) => ({ startMs: Number(l.startTimeMs), text: String(l.words || "").trim().replace(/\s+/g, " ") }))
			.filter((l) => l.text && isFinite(l.startMs) && l.startMs >= 0);
		raw.sort((a, b) => a.startMs - b.startMs);
		return raw.length ? raw : null;
	} catch (e) {
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
		const end = i + 1 < lines.length && lines[i + 1].startMs > l.startMs ? lines[i + 1].startMs : fallback;
		const endMs = Math.max(end, l.startMs + 1500);
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

function ttmlTime(s) {
	// m:ss.mmm and h:mm:ss.mmm (both occur in amll-ttml-db files).
	const m = /^(?:(\d+):)?(\d+):([\d.]+)$/.exec(String(s || "").trim());
	if (!m) return null;
	return (m[1] ? parseInt(m[1], 10) * 3600000 : 0) +
		parseInt(m[2], 10) * 60000 + Math.round(parseFloat(m[3]) * 1000);
}

function parseTTML(text) {
	// Minimal TTML -> normalized lines. <p begin end> rows with optional
	// timed word <span>s. Regex-based (no DOM needed): amll-ttml-db files
	// are machine-generated and uniform. Returns
	// [{text, startMs, endMs, words:[{text,startMs,endMs}]|null, bg}].
	const lines = [];
	const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi;
	let pm;
	while ((pm = pRe.exec(text || ""))) {
		const b = ttmlTime((/begin="([^"]*)"/.exec(pm[1]) || [])[1]);
		const e = ttmlTime((/end="([^"]*)"/.exec(pm[1]) || [])[1]);
		if (b == null || e == null || e <= b) continue;
	 const inner = pm[2];
		const words = [];
		const sRe = /<span\b([^>]*)>([^<]*)<\/span\s*>/gi;
		let sm, ok = true;
		while ((sm = sRe.exec(inner))) {
			const ws = ttmlTime((/begin="([^"]*)"/.exec(sm[1]) || [])[1]);
			const we = ttmlTime((/end="([^"]*)"/.exec(sm[1]) || [])[1]);
			const wt = (sm[2] || "").trim();
			if (!wt || ws == null || we == null || we <= ws) { ok = false; break; }
			words.push({ text: wt, startMs: ws, endMs: we });
		}
		if (!ok) continue;
		const plain = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (!plain && !words.length) continue;
		const fullParen = plain.length > 2 && plain.startsWith("(") && plain.endsWith(")");
		lines.push({
			text: fullParen ? plain.slice(1, -1).trim() : plain,
			startMs: b, endMs: e,
			words: words.length >= 2 ? words : null,
			bg: fullParen,
		});
	}
	lines.sort((a, b) => a.startMs - b.startMs);
	return lines;
}

async function fetchAMLL(trackId) {
	// Word-level community TTML by exact Spotify ID (CC0 database).
	// 404/absent -> null (chain moves on). Real word timings when the
	// file carries >=2 timed spans on most lines, else line-level.
	if (!trackId) return null;
	const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
	const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 8000);
	try {
		const res = await fetch(
			`https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/spotify-lyrics/${trackId}.ttml`,
			ctrl ? { signal: ctrl.signal } : undefined
		);
		if (!res.ok) return null;
		const parsed = parseTTML(await res.text());
		if (!parsed.length) return null;
		const real = parsed.filter((l) => l.words);
	 const useReal = real.length >= Math.ceil(parsed.length / 2);
		const lines = parsed.map((l) => ({
			text: l.text, startMs: l.startMs, endMs: l.endMs, bg: l.bg,
			words: useReal && l.words ? l.words : [{ text: l.text, startMs: l.startMs, endMs: l.endMs }],
		}));
		return {
			syncType: useReal ? "SYLLABLE_SYNCED" : "LINE_SYNCED",
			wordTiming: !useReal ? "interpolated" : parsed.every((l) => l.words) ? "real" : "mixed",
			lines,
		};
	} catch (e) {
		return null;
	} finally {
		try { clearTimeout(timer); } catch (e) {}
	}
}

async function fetchLRCLIB(info) {
	const q = (k, v) => `${k}=${encodeURIComponent(v || "")}`;
	const url = `https://lrclib.net/api/get?${q("track_name", info.title)}&${q("artist_name", info.artist)}&${q("album_name", info.album)}&duration=${info.durationSec}`;
	const res = await fetch(url, { headers: { "x-user-agent": "lyricly-spicetify-app" } });
	if (res.status !== 200) return { status: res.status, lines: null };
	const body = await res.json();
	if (body.instrumental) return { status: 200, instrumental: true, lines: null };
	if (!body.syncedLyrics) return { status: 200, lines: null };
	const lines = parseLRC(body.syncedLyrics);
	return { status: 200, lines: lines.length ? lines : null };
}

function peekNextUri() {
	// Best-effort one-track lookahead. All shapes are probed defensively;
	// null = prefetch silently skipped (documented, not an error).
	try {
		const P = Spicetify.Player;
		if (P && typeof P.getNextTrack === "function") {
			const t = P.getNextTrack();
			if (t && t.uri) return t.uri;
		}
		const Q = Spicetify.Queue;
		const cand = Q && (Q.nextTracks || (Q.queue && Q.queue.next) || Q.next);
		if (Array.isArray(cand) && cand[0] && cand[0].uri) return cand[0].uri;
		const d = P && P.data && P.data.item && P.data.item.next;
		if (d && d.uri) return d.uri;
	} catch (e) {}
	return null;
}

function trackInfoForUri(uri) {
	// Prefetch resolves the provider chain for a not-yet-playing URI
	// using current track fields as the LRCLIB query (Spotify provider
	// uses the peeked track ID, which IS exact).
	const cur = trackInfo();
	const parts = String(uri || "").split(":");
	return { ...cur, uri: uri || "", trackId: parts.length === 3 ? parts[2] : "" };
}

async function resolveLyrics(info) {
	// Chain: Spotify color-lyrics (exact ID, official line-level) ->
	// amll-ttml-db (exact ID, real word timings when lucky) -> LRCLIB
	// (fuzzy) -> null. Word-level results outrank interpolated lines:
	// an amll SYLLABLE pack beats the Spotify line pack.
	// Returns { provider, syncType, wordTiming, lines, trackId } or null.
	let spot = null;
	try {
		const sp = await fetchSpotifyLyrics(info);
		if (sp) {
			const lines = markBgLines(shapeLines(sp, info.durationMs));
			if (lines.length) spot = { provider: "spotify", syncType: "LINE_SYNCED", wordTiming: "interpolated", lines, trackId: info.trackId };
		}
	} catch (e) {}
	try {
		const am = await fetchAMLL(info.trackId);
		// Any real (syllable-level) timing outranks interpolated lines.
		if (am && am.syncType === "SYLLABLE_SYNCED" && am.lines.length) {
			const pack = { ...am, provider: "amll", trackId: info.trackId };
			logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, spot ? "spotify line-only" : null);
			return pack;
		}
		if (am && !spot) {
			// amll line-level only and Spotify missed: still better than fuzzy.
			const pack = { ...am, provider: "amll", trackId: info.trackId };
			logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "spotify miss");
			return pack;
		}
	} catch (e) {}
	if (spot) {
		logSyncType(spot.trackId, spot.provider, spot.syncType, spot.wordTiming, null);
		return spot;
	}
	try {
		const lr = await fetchLRCLIB(info);
		if (lr && !lr.instrumental && lr.lines) {
			const lines = markBgLines(shapeLines(lr.lines, info.durationMs));
			if (lines.length) {
				const pack = { provider: "lrclib", syncType: "LINE_SYNCED", wordTiming: "interpolated", lines, trackId: info.trackId || info.uri };
				logSyncType(pack.trackId, pack.provider, pack.syncType, pack.wordTiming, "spotify miss");
				return pack;
			}
		}
		if (lr && lr.instrumental) {
			logSyncType(info.trackId || info.uri, "none", "UNSYNCED", "none", "instrumental");
			return { provider: "none", syncType: "UNSYNCED", wordTiming: "none", lines: [], trackId: info.trackId || info.uri, instrumental: true };
		}
	} catch (e) {}
	logSyncType(info.trackId || info.uri, "none", "UNSYNCED", "none", "no lyrics");
	return null;
}

async function prefetchNext(resolveFn) {
	const uri = peekNextUri();
	if (!uri || cacheGet(uri)) return;
	try {
		const pack = await (resolveFn || resolveLyrics)(trackInfoForUri(uri));
		if (pack && pack.lines && pack.lines.length) cacheSet(uri, pack);
	} catch (e) {}
}

export {
	CACHE_LIMIT, cacheGet, cacheSet, sessionStats, logSyncType,
	countSyllables, parseLRC, fetchSpotifyLyrics, shapeLines,
	looksBg, splitWordsTimed, markBgLines, ttmlTime, parseTTML, fetchAMLL,
	trackInfo, trackIdFromUri, fetchLRCLIB,
	peekNextUri, trackInfoForUri, resolveLyrics, prefetchNext,
};
