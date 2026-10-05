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
	cacheGet, cacheSet,
	trackInfo, resolveLyrics, interpolatePlaybackPosition,
} from "./data.js";
import { toAMLLLines } from "./amll-map.js";

const React = Spicetify.React;
const PLAYER_SAMPLE_MS = 200;
const LYRIC_FRAME_INTERVAL_MS = 1000 / 30;
const SEEK_THRESHOLD_MS = 750;
const BACKGROUND_RENDER_SCALE = 0.8;
const BACKGROUND_RENDER_MAX_DPR = 1.25;

// AMLL core stylesheet, injected once (bundled as text — no extra files).
try {
	if (!document.getElementById("lyricly-amll-css")) {
		const st = document.createElement("style");
		st.id = "lyricly-amll-css";
		st.textContent = coreCss;
		document.head.appendChild(st);
	}
} catch (e) {
	console.error("[lyricly] AMLL stylesheet injection failed.", e);
}

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
	const loadVersionRef = React.useRef(0);

	const setLines = (amLines, trackId) => {
		const am = amRef.current;
		if (!am) return false;
		let pos = 0;
		try { pos = Spicetify.Player.getProgress() || 0; } catch (e) {}
		pos = Math.max(0, Math.round(pos));
		try {
			am.player.setLyricLines(amLines, pos);
			am.player.setCurrentTime(pos, true);
			am.player.update(0);
		} catch (e) {
			console.error("[lyricly] renderer rejected the current lyrics.", { trackId, error: e });
			return false;
		}
		try {
			if (am.background) am.background.setHasLyric(amLines.length > 0);
		} catch (e) {}
		return true;
	};

	const loadTrack = async () => {
		const requestId = ++loadVersionRef.current;
		const isCurrentRequest = () => requestId === loadVersionRef.current;
		const am = amRef.current;
		const info = trackInfo();
		setUi((s) => ({ ...s, phase: "loading", info, staticLines: null }));
		try { am && am.player.setLyricLines([], 0); } catch (e) {}
		if (!info.title) {
			setUi((s) => ({ ...s, phase: "idle", info }));
			return;
		}
		const usePack = (pack, cached) => {
			if (!isCurrentRequest()) return true;
			if (!pack || (!pack.instrumental && (!pack.lines || !pack.lines.length))) return false;
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
			if (!setLines(timed, pack.trackId)) {
				console.warn("[lyricly] Showing static lyrics because the animated renderer rejected the track.");
				setUi((s) => ({
					...s, phase: "static",
					staticLines: pack.lines.map((line) => line.text).filter(Boolean),
					source: pack.provider + " (static fallback)",
				}));
				return true;
			}
			setUi((s) => ({
				...s, phase: "ready", staticLines: null,
				source: pack.provider + " · " + pack.syncType.toLowerCase().replace("_", "-") +
					(pack.wordTiming === "real" ? " · real words" : "") + (cached ? " (cached)" : ""),
			}));
			return true;
		};
		const cached = info.uri && cacheGet(info.uri);
		if (cached && usePack({ ...cached, trackId: info.trackId || info.uri }, true)) {
			return;
		}
		try {
			const pack = await resolveLyrics(info);
			if (!isCurrentRequest()) return;
			if (info.uri && pack && pack.lines && pack.lines.length && !pack.instrumental) {
				cacheSet(info.uri, pack);
			}
			if (pack && usePack(pack, false)) {
				return;
			}
		} catch (e) {
			console.error("[lyricly] lyric loading failed.", e);
		}
		if (!isCurrentRequest()) return;
		try { am && am.player.setLyricLines([], 0); } catch (e2) {}
		setUi((s) => ({ ...s, phase: "none", staticLines: null, source: "" }));
	};

	React.useEffect(() => {
		// Init AMLL instances once, mount into the host container.
		let player = null, background = null;
		const backgroundRenderScale = () => {
			const dpr = Number(window.devicePixelRatio) || 1;
			return Math.min(BACKGROUND_RENDER_SCALE, BACKGROUND_RENDER_MAX_DPR / dpr);
		};
		let initialRenderScale = backgroundRenderScale();
		try {
			player = new LyricPlayer();
			background = BackgroundRender.new(MeshGradientRenderer);
			try { background.setFPS(30); } catch (e) {}
			initialRenderScale = backgroundRenderScale();
			try { background.setRenderScale(initialRenderScale); } catch (e) {}
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
		amRef.current = {
			player, background, raf: 0, lastRaw: null, lastUpdate: -1,
			anchorProgress: 0, anchorAt: 0, lastPlayerSample: 0,
			anchorDuration: 0, lastPushed: -1, isPlaying: null,
			renderScale: initialRenderScale, backgroundRenderScale,
		};

		try {
			player.addEventListener("line-click", (ev) => {
				try {
					const t = ev && ev.line && typeof ev.line.getLine === "function"
						? ev.line.getLine().startTime : null;
					if (isFinite(t) && t >= 0) {
						seekPlayer(Math.round(t));
						try { player.setCurrentTime(Math.round(t), true); } catch (e2) {}
						if (!amRef.current || !amRef.current.isPlaying) {
							try { player.update(0); } catch (e2) {}
						}
					}
				} catch (e2) {}
			});
		} catch (e) {}

		// Spotify's progress API advances less often than the display, so
		// interpolate between samples while limiting AMLL work to 30 FPS.
		const frame = (now) => {
			const am = amRef.current;
			if (!am) return;
			if (document.hidden) {
				am.raf = 0;
				return;
			}
			am.raf = requestAnimationFrame(frame);
			if (am.lastUpdate >= 0 && now - am.lastUpdate < LYRIC_FRAME_INTERVAL_MS) return;
			try {
				const dt = am.lastUpdate < 0 ? 0 : Math.min(now - am.lastUpdate, 100);
				am.lastUpdate = now;
				const spotifyPlayer = Spicetify.Player;
				if (!am.anchorAt || now - am.lastPlayerSample >= PLAYER_SAMPLE_MS) {
					let raw = am.anchorProgress;
					try { raw = Number(spotifyPlayer.getProgress()) || 0; } catch (e) {}
					let duration = 0;
					try { duration = Number(spotifyPlayer.getDuration()) || 0; } catch (e) {}
					am.anchorDuration = duration;
					raw = Math.max(0, duration > 0 ? Math.min(raw, duration) : raw);
					const hadAnchor = am.anchorAt > 0;
					const predicted = interpolatePlaybackPosition(am.anchorProgress, am.anchorAt, now, am.isPlaying, duration);
					const correction = raw - predicted;
					if (!hadAnchor || Math.abs(correction) > SEEK_THRESHOLD_MS) {
						am.anchorProgress = raw;
						am.anchorAt = now;
						if (hadAnchor && Math.abs(correction) > SEEK_THRESHOLD_MS) {
							try { player.setCurrentTime(Math.round(raw), true); } catch (e) {}
						}
					} else if (!am.isPlaying) {
						am.anchorProgress = raw;
						am.anchorAt = now;
					} else {
						am.anchorProgress = Math.max(0, predicted + Math.max(-40, Math.min(40, correction * 0.25)));
						am.anchorAt = now;
					}
					am.lastRaw = raw;
					am.lastPlayerSample = now;
				}
				const position = interpolatePlaybackPosition(am.anchorProgress, am.anchorAt, now, am.isPlaying, am.anchorDuration);
				if (Math.abs(position - am.lastPushed) >= 8) {
					try { player.setCurrentTime(Math.round(position)); } catch (e) {}
					am.lastPushed = position;
				}
				try { player.update(dt); } catch (e) {}
			} catch (e) {}
		};
		const onPlayPause = (eventOrForce = false) => {
			const am = amRef.current;
			if (!am) return;
			const force = eventOrForce === true;
			let playing = false;
			try { playing = !!Spicetify.Player.isPlaying(); } catch (e) {}
			if (!force && playing === am.isPlaying) return;
			am.isPlaying = playing;
			am.lastUpdate = -1;
			am.lastPlayerSample = 0;
			am.anchorAt = 0;
			if (playing && !document.hidden) {
				try { player.resume(); } catch (e) {}
				try { background.resume(); } catch (e) {}
				if (!am.raf) am.raf = requestAnimationFrame(frame);
				return;
			}
			if (am.raf) cancelAnimationFrame(am.raf);
			am.raf = 0;
			if (!playing) {
				let raw = 0;
				try { raw = Number(Spicetify.Player.getProgress()) || 0; } catch (e) {}
				let duration = 0;
				try { duration = Number(Spicetify.Player.getDuration()) || 0; } catch (e) {}
				const now = performance.now();
				am.anchorProgress = Math.max(0, duration > 0 ? Math.min(raw, duration) : raw);
				am.anchorDuration = duration;
				am.anchorAt = now;
				am.lastPlayerSample = now;
				try { player.setCurrentTime(Math.round(am.anchorProgress)); } catch (e) {}
				try { player.update(0); } catch (e) {}
				am.lastPushed = am.anchorProgress;
			}
			try { player.pause(); } catch (e) {}
			try { background.pause(); } catch (e) {}
		};
		const onVisibilityChange = () => {
			const am = amRef.current;
			if (!am) return;
			if (document.hidden) {
				if (am.raf) cancelAnimationFrame(am.raf);
				am.raf = 0;
				try { am.player.pause(); } catch (e) {}
				try { am.background.pause(); } catch (e) {}
				am.anchorAt = 0;
				am.lastPlayerSample = 0;
				am.lastUpdate = -1;
				am.lastPushed = -1;
			} else onPlayPause(true);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		const onResize = () => {
			const am = amRef.current;
			if (!am) return;
			const scale = am.backgroundRenderScale();
			if (scale !== am.renderScale) {
				am.renderScale = scale;
				try { am.background.setRenderScale(scale); } catch (e) {}
			}
		};
		window.addEventListener("resize", onResize);

		const pushArt = () => {
			try {
				const u = (trackInfo() || {}).art;
				const am2 = amRef.current;
				if (u && am2 && am2.lastArt !== u) {
					am2.lastArt = u;
					Promise.resolve()
						.then(() => am2.background.setAlbum(u))
						.catch((e) => console.warn("[lyricly] album art update failed.", e));
				}
			} catch (e) {
				console.warn("[lyricly] album art lookup failed.", e);
			}
		};

		const onSongChange = () => {
			pushArt();
			try {
				const am2 = amRef.current;
				if (am2) {
					am2.lastRaw = null;
					am2.anchorProgress = 0;
					am2.anchorAt = 0;
					am2.lastPlayerSample = 0;
					am2.anchorDuration = 0;
					am2.lastPushed = -1;
				}
			} catch (e) {}
			loadTrack();
		};
		try { Spicetify.Player.addEventListener("songchange", onSongChange); } catch (e) {}
		try { Spicetify.Player.addEventListener("onplaypause", onPlayPause); } catch (e) {}

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

		pushArt();
		loadTrack();
		onPlayPause(true);
		return () => {
			loadVersionRef.current++;
			try { cancelAnimationFrame(amRef.current ? amRef.current.raf : 0); } catch (e) {}
			try { Spicetify.Player.removeEventListener("songchange", onSongChange); } catch (e) {}
			try { Spicetify.Player.removeEventListener("onplaypause", onPlayPause); } catch (e) {}
			try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) {}
			try { window.removeEventListener("resize", onResize); } catch (e) {}
			try { window.removeEventListener("keydown", onKey, true); } catch (e) {}
		 try {
				const am2 = amRef.current;
				amRef.current = null;
				if (am2) {
					try { am2.background && am2.background.dispose(); } catch (e) {}
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
					React.createElement("div", { className: "lyricly-hint" }, "Checked LRCLIB word timing, then Spotify synced lyrics."))
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
