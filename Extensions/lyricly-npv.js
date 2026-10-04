// Lyricly NPV: Now Playing sidebar upgrades (page context, guarded).
// - playback context block (slim red progress + play/skip + live lyric line)
// - red glow wash behind the cover, eq indicator, compact-on-scroll
// - tap lyric card -> Lyricly view; all selectors structural with fallbacks
(function () {
	"use strict";

	var PLAY_SVG = '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
	var PAUSE_SVG = '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M4 2.5h3.5v11H4zM8.5 2.5H12v11H8.5z"/></svg>';
	var SKIP_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.5 2.5v11l7-4.2v4.2h2.5v-11H9.5v4.2z" transform="translate(0.5,0)"/></svg>';
	var PREV_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M13.5 2.5v11l-7-4.2v4.2H4v-11h2.5v4.2z" transform="translate(-0.5,0)"/></svg>';

	var lyricCache = {}; // uri -> { lines:[{startMs,text}] } (LRCLIB line-level)
	var lyricKeys = [];

	function P() {
		try { return window.Spicetify && window.Spicetify.Player ? window.Spicetify.Player : null; } catch (e) { return null; }
	}
	function curUri() {
		try {
			var p = P();
			var it = p && p.data && p.data.item;
			return (it && it.uri) || "";
		} catch (e) { return ""; }
	}
	function curMeta() {
		try {
			var p = P();
			var m = p && p.data && p.data.item && p.data.item.metadata;
			return {
				title: (m && m.title) || "",
				artist: (m && (m.artist_name || m.artist_title)) || "",
				durationMs: (p && p.getDuration && p.getDuration()) || 0,
			};
		} catch (e) { return { title: "", artist: "", durationMs: 0 }; }
	}

	function findPanel() {
		try {
			var marked = document.querySelector(".lyr-npv");
			if (marked && marked.isConnected) return marked;
			var btns = document.querySelectorAll("button");
			var likeBtn = null, shareBtn = null;
			for (var i = 0; i < btns.length; i++) {
				var a = ((btns[i].getAttribute && btns[i].getAttribute("aria-label")) || "").toLowerCase();
				if (!likeBtn && (a.indexOf("like") >= 0 || a.indexOf("save to") >= 0)) likeBtn = btns[i];
				if (!shareBtn && a.indexOf("share") >= 0) shareBtn = btns[i];
				if (likeBtn && shareBtn) break;
			}
			var anchor = likeBtn || shareBtn;
			if (!anchor) return null;
			var el = anchor, guard = 0;
			while (el && el !== document.body && guard < 9) {
			 el = el.parentElement;
				guard++;
				try {
					if (el && el.querySelector && el.querySelector("button") && el.textContent && el.textContent.length > 40) {
						el.classList.add("lyr-npv");
						return el;
					}
				} catch (e) {}
			}
		} catch (e) {}
		return null;
	}

	function el(tag, cls, parent) {
		var d = document.createElement(tag);
		if (cls) d.className = cls;
		if (parent) parent.appendChild(d);
		return d;
	}

	function buildBlock(panel) {
		try {
			if (panel.querySelector(":scope > .lyr-ctx")) return panel.querySelector(":scope > .lyr-ctx");
			var box = el("div", "lyr-ctx", panel);
			var line = el("div", "lyr-line", box); line.textContent = "";
			var eq = el("div", "lyr-eq", box);
			eq.innerHTML = "<span></span><span></span><span></span>";
			try {
				line.addEventListener("click", function () {
					try {
						var links = document.querySelectorAll('a[href*="lyricly" i]');
						var H = window.Spicetify && window.Spicetify.Platform && window.Spicetify.Platform.History;
						if (H && typeof H.push === "function" && links.length) { H.push(links[0].getAttribute("href")); return; }
						if (links.length) { links[0].click(); }
					} catch (e) {}
				});
			} catch (e) {}
			return box;
		} catch (e) { return null; }
	}

	function fmt(ms) {
		ms = Math.max(0, Math.round(ms || 0) / 1000);
		return Math.floor(ms / 60) + ":" + String(ms % 60).padStart(2, "0");
	}

	function lyricLines(uri, meta, done) {
		try {
			if (lyricCache[uri]) { done(lyricCache[uri]); return; }
			var url = "https://lrclib.net/api/get?track_name=" + encodeURIComponent(meta.title || "") +
				"&artist_name=" + encodeURIComponent(meta.artist || "") +
				"&duration=" + Math.round((meta.durationMs || 0) / 1000);
			fetch(url, { headers: { "x-user-agent": "lyricly-npv" } })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (b) {
					var out = { lines: [] };
				 try {
						if (b && b.syncedLyrics) {
							var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g, m, rows = [];
							var parts = String(b.syncedLyrics).split("\n");
							for (var i = 0; i < parts.length; i++) {
								var tags = parts[i].match(re);
								if (!tags) continue;
								var txt = parts[i].replace(re, "").trim();
								if (!txt) continue;
								for (var k = 0; k < tags.length; k++) {
									var mm = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(tags[k]);
									if (mm) rows.push({ startMs: Math.round((parseInt(mm[1], 10) * 60 + parseFloat(mm[2])) * 1000), text: txt });
								}
							}
							rows.sort(function (x, y) { return x.startMs - y.startMs; });
							out.lines = rows;
						}
					} catch (e) {}
					lyricCache[uri] = out;
					lyricKeys.push(uri);
					if (lyricKeys.length > 20) delete lyricCache[lyricKeys.shift()];
					done(out);
				})
				.catch(function () { done({ lines: [] }); });
		} catch (e) { done({ lines: [] }); }
	}

	var lastUri = "";
	var curLines = [];
	function tick() {
		try {
			var panel = findPanel();
			if (!panel) return;
			var box = buildBlock(panel);
			if (!box) return;
		 var p = P();
			var pos = 0, dur = 0;
			try { pos = (p && p.getProgress && p.getProgress()) || 0; } catch (e) {}
			try { dur = (p && p.getDuration && p.getDuration()) || 0; } catch (e) {}
			var uri = curUri();
			if (uri !== lastUri) {
				lastUri = uri;
				curLines = [];
				var meta = curMeta();
				if (uri) lyricLines(uri, meta, function (r) { curLines = r.lines || []; });
			}
		 var fill = box.querySelector(":scope > .lyr-bar > .lyr-bar-fill");
			if (fill && dur > 0) fill.style.width = Math.min(100, Math.max(0, (pos / dur) * 100)).toFixed(1) + "%";
			var tc = box.querySelector(":scope > .lyr-times > .lyr-tcur");
			var te = box.querySelector(":scope > .lyr-times > .lyr-tend");
			if (tc) tc.textContent = fmt(pos);
			if (te) te.textContent = fmt(dur);
			var playing = false;
			try { playing = p && p.isPlaying && typeof p.isPlaying === "function" ? !!p.isPlaying() : pos !== box.__lyrLast; } catch (e) {}
			box.__lyrLast = pos;
			box.classList.toggle("playing", !!playing);
			var bp = box.querySelector(":scope > .lyr-ctrls > .lyr-play");
			if (bp) bp.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
			var line = box.querySelector(":scope > .lyricly-line, :scope > .lyr-line");
			var active = "";
			for (var i = 0; i < curLines.length; i++) {
				if (curLines[i].startMs <= pos) active = curLines[i].text;
				else break;
			}
			if (line && line.textContent !== active) line.textContent = active;
			// compact header past scroll threshold
			try {
				var sc = panel;
				while (sc && sc !== document.body) {
					if (sc.scrollHeight > sc.clientHeight + 40) break;
					sc = sc.parentElement;
				}
				if (sc && sc !== document.body) panel.classList.toggle("compact", sc.scrollTop > 140);
			} catch (e) {}
		} catch (e) {}
	}

	try {
		setInterval(tick, 500);
	} catch (e) {}
})();
