import { isDev } from "../../components/Global/Defaults.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import PageView, { PageContainer } from "../../components/Pages/PageView.ts";
import { GetExpireStore } from "../../modules/Store.ts";
import { onExperimentChange } from "../experiments.ts";
import Logger from "../Logger.ts";
import { getRemoteConfig } from "../remoteConfig.ts";
import { $currentLyricsData, $currentLyricsType, $currentlyFetching } from "../stores.ts";
import { IsEmptyLyrics } from "./EmptyLines.ts";
import { FetchLyricaLyrics } from "./Lyrica.ts";
import { SetShownNotice, SyncNoLyricsLayout } from "./LyricsNotice.ts";
import { LyricsQueueRetry } from "./LyricsQueueRetry.ts";
import { HideLyricsSkeleton, IsLyricsSkeletonEnabled, ShowLyricsSkeleton } from "./LyricsSkeleton.ts";
import { ProcessLyrics } from "./ProcessLyrics.ts";

const lyricsLogger = new Logger("Lyrics Pipeline");
const lyricsCacheLogger = new Logger("Lyrics Cache");

// A getter, because the expiry is computed on every write: a pushed TTL applies
// to entries cached from then on, while existing ones keep the one they got.
export const LyricsStore = GetExpireStore<any>(
  "SpicyLyrics_Lyrica_LyricsStore_g1",
  6,
  {
    Unit: "Days",
    get Duration() {
      return getRemoteConfig().cache.lyricsTtlDays;
    },
  },
  isDev as true,
);

function setRomanizationClass(hasTransliterations: boolean | undefined): void {
  if (hasTransliterations) {
    PageContainer?.classList.add("Lyrics_RomanizationAvailable");
  } else {
    PageContainer?.classList.remove("Lyrics_RomanizationAvailable");
  }
}

/**
 * Shared "lyrics are ready" presentation: toggle the romanization class, hide the
 * loader, publish the type, reveal the containers and view controls, and clear the
 * fetching flag. Used by every successful return path.
 */
function presentLyrics(lyricsData: any): void {
  // Lyrics are in hand — end any 503 retry loop that was running for this track.
  LyricsQueueRetry.NotifyResolved(lyricsData?.uri);
  setRomanizationClass(lyricsData?.HasTransliterations);
  HideLoaderContainer();
  $currentLyricsType.set(lyricsData.Type);
  SetShownNotice(null);
  SyncNoLyricsLayout();
  PageView.AppendViewControls(true);
  $currentlyFetching.set(false);
}

/**
 * A lyrics fetch result: the descriptor (a lyrics payload, or a keyword naming
 * the notice to show), the HTTP-ish status, and the uri the fetch was made for.
 * The uri lets ApplyLyrics recognise — and drop — a result that only lands
 * after the user has already skipped to another track.
 */
export type FetchLyricsResult = [object | string, number, string?] | null;

/**
 * The uri of the fetch currently in flight, or `null`.
 *
 * A second request for the SAME uri is de-duplicated — the one already running
 * will paint. A request for a DIFFERENT uri supersedes it: the older fetch is
 * left to finish, but its result carries its own uri, so ApplyLyrics drops it
 * rather than painting the previous track's lyrics (or its "no lyrics" notice)
 * over the new one.
 */
let inFlightUri: string | null = null;

/**
 * Where a fetch ended up when it didn't produce lyrics, and the underlying
 * error if there was one. The result tuple only carries a keyword, which is
 * enough to pick the notice but not to debug it, so the notice's copyable
 * report reads the rest from here.
 */
export type LyricsFetchFailure = {
  uri: string;
  /** Which stage answered: "saved state", "lyrics cache" or "API". */
  source: string;
  detail?: string;
};

let lastFailure: LyricsFetchFailure | null = null;

function noteFailure(uri: string, source: string, detail?: unknown): void {
  let text: string | undefined;
  if (detail instanceof Error) text = `${detail.name}: ${detail.message}`;
  else if (detail !== undefined) text = String(detail);
  lastFailure = { uri, source, detail: text };
}

/** The last failure recorded for `uri`, or `null` if its last fetch didn't fail. */
export function GetLastLyricsFailure(uri: string | undefined): LyricsFetchFailure | null {
  return uri && lastFailure?.uri === uri ? lastFailure : null;
}

/**
 * The uri of the most recent fetch request. Unlike `inFlightUri` this is never
 * cleared, so a fetch that finishes *after* the one that superseded it still
 * sees that it lost the race.
 */
let latestRequestedUri: string | null = null;

/**
 * True when the fetch for `uri` has been overtaken and its result must not be
 * shown: a newer fetch for a different track was started, or the player has
 * already moved on. Presenting it would paint the previous track's lyrics — or
 * its "no lyrics" notice — over the track now playing, and stamp
 * `$currentLyricsData` with the wrong track's payload.
 */
function isStaleFetch(uri: string): boolean {
  if (latestRequestedUri !== null && latestRequestedUri !== uri) return true;
  const currentUri = SpotifyPlayer.GetUri();
  return currentUri != null && currentUri !== uri;
}

/**
 * Hide the loader on behalf of the fetch for `uri` — unless that fetch has been
 * overtaken, in which case the loader belongs to the newer fetch.
 */
function hideLoaderFor(uri: string): void {
  if (!isStaleFetch(uri)) HideLoaderContainer();
}

/**
 * Skipping through uncached tracks would otherwise fire an API request for
 * every one of them. When an uncached fetch follows the previous one within
 * `rapidSwitchWindowMs`, it waits `rapidSwitchBackoffMs` (loader up) and only
 * goes to the network if the user is still on the track. Both come from the
 * remote config's `lyricsFetch` group.
 */

/** When the last fetch reached the network stage, backed off or not. */
let lastNetworkStageAt = 0;

/** Ends the pending backoff early and tells its fetch to give up. */
let cancelPendingBackoff: (() => void) | null = null;

/** Resolves `true` to go ahead with the request, `false` if superseded. */
function backOffIfSwitchingFast(): Promise<boolean> {
  const { rapidSwitchWindowMs, rapidSwitchBackoffMs } = getRemoteConfig().lyricsFetch;
  const now = performance.now();
  const switchingFast = now - lastNetworkStageAt < rapidSwitchWindowMs;
  lastNetworkStageAt = now;
  if (!switchingFast) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelPendingBackoff = null;
      resolve(true);
    }, rapidSwitchBackoffMs);
    cancelPendingBackoff = () => {
      clearTimeout(timer);
      cancelPendingBackoff = null;
      resolve(false);
    };
  });
}

export default async function fetchLyrics(uri: string): Promise<FetchLyricsResult> {
  if (inFlightUri === uri) {
    lyricsLogger.debug("Fetch already in flight for this track, skipping", uri);
    return null;
  }

  // A different track was requested, so whatever is waiting out a backoff has
  // been skipped past — drop it now instead of letting its timer run out.
  cancelPendingBackoff?.();

  inFlightUri = uri;
  latestRequestedUri = uri;
  $currentlyFetching.set(true);

  try {
    const result = await runFetchLyrics(uri);
    // Stamp the result with the uri it was requested for, so a late arrival can
    // be told apart from a result for the track that's playing now.
    return result ? [result[0], result[1], uri] : null;
  } finally {
    // Only release the lock if we still hold it — a newer fetch may have taken
    // over while this one was awaiting, and the flag is then that fetch's.
    if (inFlightUri === uri) {
      inFlightUri = null;
      $currentlyFetching.set(false);
    }
  }
}

async function runFetchLyrics(uri: string): Promise<[object | string, number] | null> {
  lyricsLogger.debug("Fetch requested", uri);
  if (lastFailure?.uri === uri) lastFailure = null;
  //if (!PageContainer) return;
  const LyricsContent = PageContainer?.querySelector(".LyricsContainer .LyricsContent") ?? undefined;
  if (!LyricsContent) return;
  if (LyricsContent?.classList.contains("offline")) {
    LyricsContent.classList.remove("offline");
  }

  //if (!Fullscreen.IsOpen) PageView.AppendViewControls(true);

  if (SpotifyPlayer.IsDJ()) {
    $currentlyFetching.set(false);
    return ["dj", 400];
  }

  const mediaType = SpotifyPlayer.GetMediaType();

  if (mediaType && mediaType !== "audio") {
    $currentlyFetching.set(false);
    if (mediaType === "video") {
      return ["video-track", 400];
    } else if (mediaType === "mixed") {
      return ["mixed-track", 400];
    }
    return ["unknown-track", 400];
  }

  const contentType = SpotifyPlayer.GetContentType();
  if (contentType !== "track") {
    $currentlyFetching.set(false);
    if (contentType === "episode") {
      return ["episode-track", 400];
    }
    return ["unknown-track", 400];
  }

  const trackId = uri.split(":")[2];

  if (IsLyricsSkeletonEnabled()) ShowLyricsSkeleton();

  if (LyricsContent) {
    LyricsContent.classList.add("HiddenTransitioned");
  }

  // Check if there's already data in localStorage
  const savedLyricsData = $currentLyricsData.get();

  if (savedLyricsData && !isDev) {
    try {
      if (savedLyricsData.startsWith("NO_LYRICS:")) {
        // Sentinel format is `NO_LYRICS:<uri>`. The uri itself contains colons,
        // so strip the prefix rather than splitting on ":".
        const savedUri = savedLyricsData.slice("NO_LYRICS:".length);
        if (savedUri === uri) {
          $currentlyFetching.set(false);
          noteFailure(uri, "saved state");
          return ["lyrics-not-found", 404];
        }
      } else {
        const lyricsData = JSON.parse(savedLyricsData);
        // Return the stored lyrics if the URI matches the current track URI
        if (lyricsData?.uri === uri && lyricsData?.provider === "lyrica") {
          presentLyrics(lyricsData);
          return [lyricsData, 200];
        }
      }
    } catch (error) {
      lyricsCacheLogger.error("Error parsing saved lyrics data", error);
      $currentlyFetching.set(false);
      hideLoaderFor(uri);
    }
  }

  // Local tracks have no Spotify track id, so Lyrica cannot search them.
  if (uri.startsWith("spotify:local:")) {
    $currentlyFetching.set(false);
    return ["local-track", 400];
  }

  if (LyricsStore) {
    try {
      const lyricsFromCacheRes = await LyricsStore.GetItem(trackId);
      if (lyricsFromCacheRes) {
        if (lyricsFromCacheRes?.Value === "NO_LYRICS") {
          $currentlyFetching.set(false);
          noteFailure(uri, "lyrics cache");
          return ["lyrics-not-found", 404];
        }
        if (lyricsFromCacheRes?.provider !== "lyrica") {
          await LyricsStore.RemoveItem(trackId);
        } else {
          const lyricsFromCache = { ...(lyricsFromCacheRes ?? {}), uri };
          if (isStaleFetch(uri)) return [{ ...lyricsFromCache, fromCache: true }, 200];
          $currentLyricsData.set(JSON.stringify(lyricsFromCache));
          presentLyrics(lyricsFromCache);
          return [{ ...lyricsFromCache, fromCache: true }, 200];
        }
      }
    } catch (error) {
      lyricsCacheLogger.error("Error parsing cache entry", error);
      // Evict it, or every retry reads the same broken entry until its TTL runs out.
      await LyricsStore.RemoveItem(trackId);
      $currentlyFetching.set(false);
      noteFailure(uri, "lyrics cache", error);
      return ["unknown-error", 0];
    }
  }

  if (!navigator.onLine) {
    $currentlyFetching.set(false);
    return ["offline", 400];
  }

  // Skipped past during the cache lookups or the backoff: the newer fetch owns
  // the loader, and a null result is dropped by every caller. Checked before
  // ShowLoaderContainer too, which would otherwise cancel the newer fetch's
  // pending loader reveal.
  if (isStaleFetch(uri)) return null;

  ShowLoaderContainer(uri);

  if (!(await backOffIfSwitchingFast()) || isStaleFetch(uri)) {
    lyricsLogger.debug("Skipped past during backoff, not fetching", uri);
    return null;
  }

  try {
    const title = SpotifyPlayer.GetName() ?? "";
    const artist =
      SpotifyPlayer.GetArtists()
        ?.map((item) => item.name)
        .filter(Boolean)
        .join(", ") ?? "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let lyricsQuery;
    try {
      lyricsQuery = await FetchLyricaLyrics(title, artist, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    const status = lyricsQuery.status;
    if (status === 503 && isStaleFetch(uri)) return ["lyrics-queued", 503];
    if (status === 503) {
      $currentlyFetching.set(false);
      LyricsQueueRetry.HandleQueued(uri);
      return ["lyrics-queued", 503];
    }
    if (status !== 200) {
      noteFailure(uri, "Lyrica", "query status " + status);
      if (status === 429) {
        hideLoaderFor(uri);
        $currentlyFetching.set(false);
        return ["rate-limited", 429];
      }
      hideLoaderFor(uri);
      $currentlyFetching.set(false);
      return status === 404 ? ["lyrics-not-found", 404] : ["status-not-200", status];
    }

    const lyrics = lyricsQuery.lyrics;
    if (!lyrics) {
      hideLoaderFor(uri);
      $currentlyFetching.set(false);
      noteFailure(uri, "Lyrica", "empty lyrics payload");
      return ["lyrics-not-found", 404];
    }
    await ProcessLyrics(lyrics);

    // Pruning blank lines can empty out a payload the API still counted as a
    // hit. Nothing would render, so treat it as a miss rather than caching and
    // publishing an empty lyrics card.
    if (IsEmptyLyrics(lyrics)) {
      lyricsLogger.warn("Lyrics payload had no renderable lines after pruning");
      hideLoaderFor(uri);
      $currentlyFetching.set(false);
      noteFailure(uri, "Lyrica", "no renderable lines after pruning");
      return ["lyrics-not-found", 404];
    }

    // Stamp the uri so every match downstream (saved-data, re-fetch, cache)
    // keys off the stable uri instead of the API-supplied id.
    lyrics.uri = uri;

    // The request already completed, so cache it either way — even if the user
    // has skipped on, the next play of this track gets a cache hit.
    if (LyricsStore) {
      try {
        await LyricsStore.SetItem(trackId, lyrics);
      } catch (error) {
        lyricsCacheLogger.error("Error saving lyrics to cache", error);
      }
    }

    if (isStaleFetch(uri)) return [{ ...lyrics, fromCache: false }, 200];

    $currentLyricsData.set(JSON.stringify(lyrics));
    presentLyrics(lyrics);
    return [{ ...lyrics, fromCache: false }, 200];
  } catch (error) {
    $currentlyFetching.set(false);
    hideLoaderFor(uri);
    noteFailure(uri, "Lyrica", error);
    if (error instanceof TypeError || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")) {
      lyricsLogger.warn("Lyrica request did not return a readable response", error);
      return ["service-unavailable", 0];
    }
    lyricsLogger.error("Error fetching Lyrica lyrics", error);
    return ["unknown-error", 0];
  }
}

let ContainerShowLoaderTimeout: ReturnType<typeof setTimeout> | null = null;

/** Default copy shown in the loader while a lyrics request is queued (HTTP 503). */
export const LYRICS_QUEUE_MESSAGE = "Your request is in the queue. Hang tight, your lyrics are on the way!";

/**
 * Show the loader container after a delay
 */
function ShowLoaderContainer(uri: string): void {
  // The skeleton went up when the fetch started; it replaces the spinner.
  if (IsLyricsSkeletonEnabled()) return;
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (!loaderContainer) return;
  // One pending reveal at a time. Overwriting the handle used to orphan the
  // previous track's timer, which then fired after this track's hide.
  if (ContainerShowLoaderTimeout) clearTimeout(ContainerShowLoaderTimeout);
  ContainerShowLoaderTimeout = setTimeout(() => {
    ContainerShowLoaderTimeout = null;
    if (isStaleFetch(uri) || inFlightUri !== uri) return;
    loaderContainer.classList.add("active");
  }, getRemoteConfig().lyricsFetch.loaderRevealDelayMs);
}

/**
 * Immediately reveal the loader with a "request queued" message. Used for the
 * HTTP 503 server-queue state, where we want instant feedback (no reveal delay)
 * plus a note explaining the wait. Idempotent and safe to call when the page is
 * closed (no-ops if there's no loader in the current DOM).
 */
export function ShowQueueLoader(message: string = LYRICS_QUEUE_MESSAGE): void {
  if (IsLyricsSkeletonEnabled()) {
    ShowLyricsSkeleton(message);
    return;
  }
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (!loaderContainer) return;

  // We're showing now, so cancel the delayed plain-loader reveal.
  if (ContainerShowLoaderTimeout) {
    clearTimeout(ContainerShowLoaderTimeout);
    ContainerShowLoaderTimeout = null;
  }

  loaderContainer.classList.add("active", "queued");

  let messageEl = loaderContainer.querySelector<HTMLElement>(".loaderMessage");
  if (!messageEl) {
    messageEl = document.createElement("div");
    messageEl.className = "loaderMessage";
    loaderContainer.appendChild(messageEl);
  }
  messageEl.textContent = message;
}

/**
 * Hide the loader container and clear any pending timeout
 */
export function HideLoaderContainer(): void {
  if (ContainerShowLoaderTimeout) {
    clearTimeout(ContainerShowLoaderTimeout);
    ContainerShowLoaderTimeout = null;
  }
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (loaderContainer) {
    loaderContainer.classList.remove("active", "queued");
    loaderContainer.querySelector(".loaderMessage")?.remove();
  }
}

// The CSS hides whichever loader the experiment isn't using, so flipping it
// mid-fetch would hide the one that went up and leave nothing in its place.
// Hand the loading state, and any queue message, across to the other one.
onExperimentChange((experiment) => {
  if (experiment.id !== "lyricsSkeleton") return;
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  const skeleton = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .LyricsSkeleton");
  const queuedMessage = loaderContainer?.classList.contains("queued")
    ? loaderContainer.querySelector(".loaderMessage")?.textContent
    : skeleton?.classList.contains("active") && skeleton.classList.contains("LongLabel")
      ? skeleton.querySelector(".SkeletonLabel")?.textContent
      : null;
  if (!$currentlyFetching.get() && !queuedMessage) return;

  if (IsLyricsSkeletonEnabled()) {
    HideLoaderContainer();
    ShowLyricsSkeleton(queuedMessage ?? undefined);
  } else {
    HideLyricsSkeleton();
    if (queuedMessage) ShowQueueLoader(queuedMessage);
    else loaderContainer?.classList.add("active");
  }
});

/**
 * Clear the lyrics container content
 */
export function ClearLyricsPageContainer(): void {
  const lyricsContent = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .LyricsContent");
  if (lyricsContent) {
    lyricsContent.innerHTML = "";
  }
}
