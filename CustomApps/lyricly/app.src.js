// Lyricly on AMLL — app entry (SOURCE; esbuild bundles this to index.js).
// Vanilla AMLL wiring per amll.dev guides (verified against
// @applemusic-like-lyrics/core@0.6.0 dist, AGPL-3.0-only — see note at
// the bottom). Data layer stays in ./data.js; mapping in ./amll-map.js.
//
// Host responsibilities (ours): lyric data, playback clock, album art,
// line-click seeks, cleanup. Rendering: AMLL's.
import { LyricPlayer, BackgroundRender, MeshGradientRenderer } from "@applemusic-like-lyrics/core";
import coreCss from "@applemusic-like-lyrics/core/style.css";
import {
	cacheGet, cacheSet, logSyncType,
	trackInfo, resolveLyrics, prefetchNext,
} from "./data.js";
import { toAMLLLines } from "./amll-map.js";

const React = Spicetify.React;
const LOOKAHEAD_MS = 0; // added to display reads (output latency); default 0 per measured drift
const STALL_PAUSE_MS = 800; // unchanged progress this long = paused

// AMLL core stylesheet, injected once (bundled as text — no extra files).
try {
	if (!document.getElementById("lyricly-amll-css")) {
		const st = document.createElement("style");
		st.id = "lyricly-amll-css";
		st.textContent = coreCss;
		document.head.appendChild(st);
	}
} catch (e) {}

function seekPlayer(ms) {
	try {
		const P = Spicetify.Player;
		if (P && typeof P.seek === "function") P.seek(ms);
		else if (P && typeof P.seekTo === "function") P.seekTo(ms);
	} catch (e) {}
}

function render() {
	return React.createElement(LyriclyApp, null);
}

// Side-effect anchor, doing double duty:
// 1. Marks render() (and everything it reaches) live so the bundler
//    cannot tree-shake the app away — Spicetify calls render()
//    externally at route time, which bundlers can't see.
// 2. Exposes render on the global scope, matching the classic-script
//    mechanism custom apps have always used (top-level function).
try {
	globalThis.render = render;
} catch (e) {}

function LyriclyApp() {
	const [ui, setUi] = React.useState({
		phase: "loading", info: null, source: "", staticLines: null,
		debug: false, debugText: "",
	});
	const hostRef = React.useRef(null);
	const amRef = React.useRef(null); // { player, background, raf, lastRaw, lastChange, resumed, lastFrame, uri }

	const setLines = (amLines, trackId) => {
		const am = amRef.current;
		if (!am) return;
		let pos = 0;
		try { pos = Spicetify.Player.getProgress() || 0; } catch (e) {}
		pos = Math.max(0, Math.round(pos + LOOKAHEAD_MS));
		try {
			am.player.setLyricLines(amLines, pos);
			am.player.setCurrentTime(pos, true);
			am.player.update(0);
		} catch (e) {}
		try {
			if (am.bg) am.bg.setHasLyric(amLines.length > 0);
		} catch (e) {}
	};

	const loadTrack = async () => {
		const am = amRef.current;
		const info = trackInfo();
		setUi((s) => ({ ...s, phase: "loading", info, staticLines: null }));
		if (!info.title) {
			setUi((s) => ({ ...s, phase: "idle", info }));
			try { am && am.player.setLyricLines([], 0); } catch (e) {}
			return;
		}
		const cacheKey = "lyricly:" + (info.uri || info.title + "|" + info.artist);
		const usePack = (pack, cached) => {
			if (!pack || !pack.lines || !pack.lines.length) return false;
			if (pack.instrumental) {
				try { am.player.setLyricLines([], 0); } catch (e) {}
				setUi((s) => ({ ...s, phase: "static", staticLines: ["♪ Instrumental ♪"], source: pack.provider }));
				return true;
			}
			const amLines = toAMLLLines(pack.lines);
			const timed = amLines.filter((l) => l.endTime > l.startTime);
			if (!timed.length) {
				// Unsynced: clear the player, show the plain static block.
				try { am.player.setLyricLines([], 0); } catch (e) {}
				setUi((s) => ({
					...s, phase: "static",
					staticLines: pack.lines.map((l) => l.text).filter(Boolean),
					source: pack.provider + (cached ? " (cached)" : ""),
				}));
				return true;
			}
			setLines(timed, pack.trackId);
			setUi((s) => ({
				...s, phase: "ready", staticLines: null,
				source: pack.provider + " · " + pack.syncType.toLowerCase().replace("_", "-") +
					(pack.wordTiming === "real" ? " · real words" : "") + (cached ? " (cached)" : ""),
			}));
			return true;
		};
		const cached = info.uri && cacheGet(info.uri);
		if (cached && usePack({ ...cached, trackId: info.trackId || info.uri }, true)) {
			prefetchNext();
			return;
		}
		try {
			const pack = await resolveLyrics(info);
			if (info.uri && pack && pack.lines && pack.lines.length && !pack.instrumental) {
				cacheSet(info.uri, pack);
			}
			if (pack && usePack(pack, false)) {
				prefetchNext();
				return;
			}
		} catch (e) {}
		try { am && am.player.setLyricLines([], 0); } catch (e2) {}
		setUi((s) => ({ ...s, phase: "none", staticLines: null, source: "" }));
		prefetchNext();
	};

	React.useEffect(() => {
		// Init AMLL instances once, mount into the host container.
		let player = null, background = null;
		try {
			player = new LyricPlayer();
			background = BackgroundRender.new(MeshGradientRenderer);
			try { background.setFPS(60); } catch (e) {}
			try { background.setRenderScale(1); } catch (e) {}
			try {
				if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
					background.setStaticMode(true);
				}
			} catch (e) {}
			const host = hostRef.current;
			if (host) {
				host.appendChild(background.getElement());
				host.appendChild(player.getElement());
			}
		} catch (e) {
			setUi((s) => ({ ...s, phase: "none" }));
			return undefined;
		}
		amRef.current = { player, background, raf: 0, lastRaw: -1, lastChange: 0, resumed: false, lastFrame: -1 };

		try {
			player.addEventListener("line-click", (ev) => {
				try {
					const t = ev && ev.line && typeof ev.line.getLine === "function"
						? ev.line.getLine().startTime : null;
					if (isFinite(t) && t >= 0) {
						seekPlayer(Math.round(t));
						try { player.setCurrentTime(Math.round(t), true); } catch (e2) {}
					}
				} catch (e2) {}
			});
		} catch (e) {}

		// Frame loop: dense progress pushes + presentation state, per guides.
		const frame = (now) => {
			const am = amRef.current;
			if (!am) return;
			am.raf = requestAnimationFrame(frame);
			try {
				if (document.hidden) return;
				const dt = am.lastFrame < 0 ? 0 : now - am.lastFrame;
				am.lastFrame = now;
				let raw = 0;
				try { raw = Spicetify.Player.getProgress() || 0; } catch (e) {}
				if (raw !== am.lastRaw) {
					am.lastRaw = raw;
					am.lastChange = now;
					if (!am.resumed) {
						try { player.resume(); } catch (e) {}
						try { background.resume(); } catch (e) {}
						am.resumed = true;
					}
					try { player.setCurrentTime(Math.max(0, Math.round(raw + LOOKAHEAD_MS))); } catch (e) {}
				} else if (now - am.lastChange > STALL_PAUSE_MS && am.resumed) {
					try { player.pause(); } catch (e) {}
					try { background.pause(); } catch (e) {}
					am.resumed = false;
				}
				try { player.update(dt); } catch (e) {}
			} catch (e) {}
		};
		amRef.current.raf = requestAnimationFrame(frame);

		const onSongChange = () => {
			try {
				const am2 = amRef.current;
				if (am2) { am2.lastRaw = -1; }
			} catch (e) {}
			loadTrack();
		};
		try { Spicetify.Player.addEventListener("songchange", onSongChange); } catch (e) {}

		const onKey = (e) => {
			try {
				if (e && e.key === "F5" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
					e.preventDefault();
					e.stopPropagation();
					setUi((s) => ({ ...s, debug: !s.debug }));
					return false;
				}
			} catch (err) {}
			return undefined;
		};
		try { window.addEventListener("keydown", onKey, true); } catch (e) {}

		// Album art -> background (CORS permitting; failures keep prior art).
		const artTimer = { id: 0 };
		const pushArt = () => {
			try {
				const u = (trackInfo() || {}).art;
				const am2 = amRef.current;
				if (u && am2 && am2.lastArt !== u) {
					am2.lastArt = u;
					Promise.resolve()
						.then(() => am2.bg.setAlbum(u))
						.catch(() => {});
				}
			} catch (e) {}
		};
		const artCheck = () => {
			pushArt();
			artTimer.id = setTimeout(artCheck, 3000);
		};
		artCheck();

		loadTrack();
		return () => {
			try { cancelAnimationFrame(amRef.current ? amRef.current.raf : 0); } catch (e) {}
			try { Spicetify.Player.removeEventListener("songchange", onSongChange); } catch (e) {}
			try { window.removeEventListener("keydown", onKey, true); } catch (e) {}
			try { clearTimeout(artTimer.id); } catch (e) {}
		 try {
				const am2 = amRef.current;
				amRef.current = null;
				if (am2) {
					try { am2.bg && am2.bg.dispose(); } catch (e) {}
					try { am2.player && am2.player.dispose(); } catch (e) {}
				}
			} catch (e) {}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const info = ui.info || {};
	return React.createElement("div", { className: "lyricly-root" },
		React.createElement("div", { className: "lyricly-stage" },
			React.createElement("div", { className: "lyricly-player", ref: hostRef }),
			// Noir veil: clamps any cover palette into the black/red range
			// so every song stays on brand (static gradient, zero motion).
			React.createElement("div", { className: "lyricly-tint", "aria-hidden": "true" }),
			ui.phase === "static" && ui.staticLines
				? React.createElement("div", { className: "lyricly-static" },
					ui.staticLines.map((t, i) => React.createElement("div", { key: i }, t)))
				: null,
			ui.phase === "none"
				? React.createElement("div", { className: "lyricly-empty" },
					React.createElement("div", { className: "lyricly-none-art" }, "♪"),
					React.createElement("div", null, "No lyrics found."),
					React.createElement("div", { className: "lyricly-hint" }, "Checked Spotify first, then LRCLIB."))
				: null,
			ui.phase === "loading" || ui.phase === "idle"
				? React.createElement("div", { className: "lyricly-empty" },
					React.createElement("div", null, ui.phase === "idle" ? "Play something to see lyrics." : "Loading lyrics…"))
				: null,
			ui.debug
				? React.createElement("div", { className: "lyricly-debug" },
					React.createElement("div", null, "source: " + (ui.source || "(none)")),
					React.createElement("div", null, "amll vanilla · rAF clock · Ctrl+F5 toggles"))
				: null));
}

// NOTE ON AMLL LICENSING (for the owner, before any publish/commit):
// @applemusic-like-lyrics/core is AGPL-3.0-only. Bundling it into this
// custom app is fine for strictly personal local use, but publishing or
// distributing the bundle (including pushing this repo publicly with the
// built index.js) triggers AGPL source-sharing obligations. Settle that
// before any commit or share. Nothing here is committed.
