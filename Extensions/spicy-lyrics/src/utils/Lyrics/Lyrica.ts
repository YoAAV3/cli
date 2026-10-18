export const LYRICA_BASE_URL = "https://test-0k.onrender.com";
export const LYRICA_SOURCE_SEQUENCE = "8,7,2,1,3,4,5,6";
export const LYRICA_REQUEST_TIMEOUT_MS = 120_000;

type LyricaWord = {
  text?: string;
  start?: number | string;
  end?: number | string;
};

type LyricaTimedLine = {
  text?: string;
  start_time?: number | string;
  end_time?: number | string;
  words?: LyricaWord[];
};

type LyricaPayload = {
  status?: string;
  source?: string;
  data?: {
    lyrics?: string;
    source?: string;
    provider?: string;
    source_name?: string;
    sync_level?: string;
    timed_lyrics?: LyricaTimedLine[];
  };
  provider?: string;
};

type SpicyLine = {
  Type: "Vocal";
  Text: string;
  StartTime: number;
  EndTime: number;
};

type SpicySyllable = {
  Text: string;
  StartTime: number;
  EndTime: number;
  IsPartOfWord: false;
};

type SpicyLyrics = {
  Type: "Line" | "Syllable" | "Static";
  provider: "lyrica";
  source?: string;
  Content?: Array<
    | SpicyLine
    | {
        Type: "Vocal";
        Lead: {
          StartTime: number;
          EndTime: number;
          Syllables: SpicySyllable[];
        };
      }
  >;
  Lines?: Array<{ Text: string }>;
};

export type LyricaLyricsResult = {
  status: number;
  lyrics: SpicyLyrics | null;
};

function sourceName(payload: LyricaPayload): string | undefined {
  const candidates = [payload.data?.source, payload.data?.provider, payload.data?.source_name, payload.source, payload.provider];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim();
}

export function normalizeLyricaResponse(payload: LyricaPayload): SpicyLyrics | null {
  if (payload.status !== "success" || !payload.data) return null;

  const source = sourceName(payload);
  const timedLines = Array.isArray(payload.data.timed_lyrics) ? payload.data.timed_lyrics : [];
  const validLines = timedLines
    .map((line) => ({
      text: String(line.text ?? "").trim(),
      start: Number(line.start_time),
      end: Number(line.end_time),
      words: Array.isArray(line.words)
        ? line.words
            .map((word) => ({
              text: String(word.text ?? "").trim(),
              start: Number(word.start),
              end: Number(word.end),
            }))
            .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start)
        : [],
    }))
    .filter((line) => line.text && Number.isFinite(line.start) && line.start >= 0)
    .sort((left, right) => left.start - right.start);
  const lines = validLines.map((line, index) => {
    const nextStart = validLines[index + 1]?.start;
    return {
      ...line,
      end:
        Number.isFinite(line.end) && line.end > line.start
          ? line.end
          : Number.isFinite(nextStart) && nextStart > line.start
            ? nextStart
            : line.start + 4000,
    };
  });

  if (lines.length) {
    const hasWordSync =
      (payload.data.sync_level === "word" || payload.data.sync_level === "syllable") && lines.every((line) => line.words.length > 0);

    if (hasWordSync) {
      return {
        Type: "Syllable",
        provider: "lyrica",
        ...(source ? { source } : {}),
        Content: lines.map((line) => ({
          Type: "Vocal" as const,
          Lead: {
            StartTime: line.start,
            EndTime: line.end,
            Syllables: line.words.map((word) => ({
              Text: word.text,
              StartTime: word.start,
              EndTime: word.end,
              IsPartOfWord: false as const,
            })),
          },
        })),
      };
    }

    return {
      Type: "Line",
      provider: "lyrica",
      ...(source ? { source } : {}),
      Content: lines.map((line) => ({
        Type: "Vocal" as const,
        Text: line.text,
        StartTime: line.start,
        EndTime: line.end,
      })),
    };
  }

  const plainLines = String(payload.data.lyrics ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!plainLines.length) return null;

  return {
    Type: "Static",
    provider: "lyrica",
    ...(source ? { source } : {}),
    Lines: plainLines.map((Text) => ({ Text })),
  };
}

export async function FetchLyricaLyrics(title: string, artist: string, signal?: AbortSignal): Promise<LyricaLyricsResult> {
  const params = new URLSearchParams({
    artist,
    song: title,
    timestamps: "true",
    word: "true",
    syllabus: "true",
    sequence: LYRICA_SOURCE_SEQUENCE,
    pass: "true",
  });
  const response = await fetch(`${LYRICA_BASE_URL}/lyrics/?${params}`, { signal });
  if (!response.ok) return { status: response.status, lyrics: null };

  const payload = (await response.json()) as LyricaPayload;
  const lyrics = normalizeLyricaResponse(payload);
  return lyrics ? { status: response.status, lyrics } : { status: 404, lyrics: null };
}
