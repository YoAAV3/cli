// track-probe: Step-1 verification app. Proves (1) custom-app injection
// works, (2) Spicetify.Player data is readable, (3) track-change events
// fire. Open it from the left sidebar, press play, change tracks.
const react = Spicetify.React;
const { useState, useEffect } = react;

function safeCall(fn, fallback) {
	try {
		const v = fn();
		return v == null ? fallback : v;
	} catch (e) {
		return fallback;
	}
}

function snapshot() {
	// Fully defensive: before first playback, origin._state (and therefore
	// getProgress/getDuration/isPlaying/Player.data) may not exist yet.
	// Anything throwing here would trip Spotify's route error boundary,
	// so every read below degrades to a placeholder instead.
	const data = safeCall(() => Spicetify.Player.data, {}) || {};
	const item = data.item || {};
	const meta = item.metadata || {};
	return {
		title: meta.title || "(nothing playing)",
		artist: meta.artist_name || meta.artist_title || "-",
		album: meta.album_title || "-",
		uri: item.uri || "-",
		durationMs: safeCall(() => Spicetify.Player.getDuration(), 0),
		positionMs: safeCall(() => Math.round(Spicetify.Player.getProgress()), 0),
		playing: safeCall(() => Spicetify.Player.isPlaying(), "?"),
	};
}

function render() {
	return react.createElement(TrackProbe, null);
}

function TrackProbe() {
	const [info, setInfo] = useState(snapshot);
	const [changes, setChanges] = useState(0);
	const [log, setLog] = useState([]);

	useEffect(() => {
		const onChange = (e) => {
			const s = snapshot();
			setInfo(s);
			setChanges((c) => c + 1);
			setLog((l) =>
				[
					new Date().toLocaleTimeString() + " songchange -> " + s.title,
					...l,
				].slice(0, 8)
			);
		};
		Spicetify.Player.addEventListener("songchange", onChange);
		const tick = setInterval(() => setInfo(snapshot()), 1000);
		return () => {
			Spicetify.Player.removeEventListener("songchange", onChange);
			clearInterval(tick);
		};
	}, []);

	const row = (k, v) =>
		react.createElement(
			"div",
			{ style: { margin: "4px 0" } },
			react.createElement("b", null, k + ": "),
			String(v)
		);

	return react.createElement(
		"div",
		{ style: { padding: "24px", fontSize: "15px" } },
		react.createElement("h1", null, "TrackProbe"),
		react.createElement(
			"p",
			null,
			"Injection + Player API + songchange events, live:"
		),
		row("title", info.title),
		row("artist", info.artist),
		row("album", info.album),
		row("uri", info.uri),
		row("positionMs", info.positionMs + " / " + info.durationMs),
		row("playing", info.playing),
		row("songchange events seen", changes),
		react.createElement("h3", null, "Event log"),
		react.createElement(
			"ul",
			null,
			log.map((line, i) => react.createElement("li", { key: i }, line))
		)
	);
}
