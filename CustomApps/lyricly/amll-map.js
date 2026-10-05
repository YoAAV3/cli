// Normalized pack -> AMLL LyricLine[] mapping. Pure (no DOM, no AMLL
// imports): unit-testable in plain node. Verified field names against
// @applemusic-like-lyrics/core@0.6.0 dist typings:
//   LyricWordBase { word: string, startTime: number, endTime: number }
//   LyricLine { words, translatedLyric, romanLyric, startTime, endTime,
//               isBG, isDuet }
// Rules:
// - integer ms everywhere (AMLL expects integer milliseconds)
// - translatedLyric/romanLyric always "" — we never fetch translations,
//   so English-only holds by construction (nothing to strip)
// - isDuet always false — neither source carries singer tags
// - consecutive bg lines merge into ONE (AMLL shows a single bg line per
//   lead); its span covers first.start..last.end
// - words with non-finite timings are dropped; a line left wordless falls
//   back to a single word spanning the line (line-level convention);
//   lines without finite start/end are dropped (caller shows static)
function toAMLLWord(w, lineStart, lineEnd) {
	if (!w || typeof w.text !== "string" || !w.text) return null;
	const s = Number(w.startMs), e = Number(w.endMs);
	const startTime = Math.round(isFinite(s) ? s : lineStart);
	const endTime = Math.round(isFinite(e) && e > startTime ? e : lineEnd);
	if (!isFinite(startTime) || !isFinite(endTime) || endTime < startTime) return null;
	return { word: w.text, startTime, endTime };
}

// AMLL concatenates word strings verbatim — its own parsers keep the
// separator inside the segment (" When", " the"). Without this, words
// render glued together with no spaces.
function spaceWords(words) {
	return (words || []).map((w, i) => {
		const text = String(w.word);
		if (i === 0) return { ...w, word: text.replace(/^\s+/, "") };
		const previous = String(words[i - 1].word);
		return {
			...w,
			word: /\s$/.test(previous) || /^\s/.test(text) ? text : " " + text,
		};
	});
}

function toAMLLLines(lines) {
	const out = [];
	let pendingBg = null;
	const flushBg = () => {
		if (pendingBg && pendingBg.words.length) out.push(pendingBg);
		pendingBg = null;
	};
	for (const l of lines || []) {
		// Null times = untimed: drop the line (the caller shows its
		// static fallback instead). Never coerce null to 0 — a 0-0 line
		// would flash highlighted at song start.
		if (l.startMs == null || l.endMs == null) continue;
		const startTime = Math.round(Number(l.startMs));
		const endTime = Math.round(Number(l.endMs));
		if (!isFinite(startTime) || !isFinite(endTime) || endTime < startTime) continue;
		const words = spaceWords((l.words || [])
			.map((w) => toAMLLWord(w, startTime, endTime))
			.filter(Boolean));
		if (!words.length) {
			// Line-level convention: one word spanning the line.
			words.push({ word: String(l.text || ""), startTime, endTime });
		}
	 const entry = {
			words,
			translatedLyric: "",
			romanLyric: "",
			startTime,
			endTime,
			isBG: !!l.bg,
			isDuet: false,
		};
		if (entry.isBG) {
			// Merge runs: extend the pending bg line instead of emitting
			// a second one (AMLL shows one bg per lead).
			if (!pendingBg) {
				pendingBg = entry;
			} else {
				pendingBg.words = spaceWords(pendingBg.words.concat(entry.words));
				pendingBg.endTime = Math.max(pendingBg.endTime, entry.endTime);
			}
		} else {
			flushBg();
			out.push(entry);
		}
	}
	flushBg();
	return out;
}

export { toAMLLLines, toAMLLWord };
