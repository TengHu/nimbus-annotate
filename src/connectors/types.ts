// Mirrors the upstream Modal API shapes as closely as possible.

export type Interval = {
  start: number;
  end: number;
  label?: string;
};

export type IntervalText = {
  start: number;
  end: number;
  text: string;
};

export type SourceTranscript = {
  text: string;
  interval_transcripts: IntervalText[];
};

export type IntervalsPayload = { intervals: Interval[] };
export type TurnsPayload = { turns: IntervalText[] };

export type ConversationMeta = {
  id: string;
  volume: string;
  group?: string;
  durationSeconds?: number;
  hasAnnotation: boolean;
};

export type Conversation = {
  id: string;
  volume: string;
  audioUrl: string;
  groundTruth: IntervalsPayload;
  humanAnnotation: IntervalsPayload;
  sourceTranscript: SourceTranscript;
  turnTranscripts: TurnsPayload;
};

// Saved annotation = the flat list itself. Metadata (savedAt, annotator) is
// embedded in the filename, not in the file body. On the wire and on disk the
// items use {start, end, transcript}; inside our code we use {start, end, text}
// to match the source-transcript shape. Output connectors do the rename.
export type SavedTurn = { start: number; end: number; transcript: string };
export type SavedAnnotation = SavedTurn[];

export interface InputConnector {
  list(): Promise<ConversationMeta[]>;
  get(id: string, volume: string): Promise<Conversation>;
  getAudio(id: string, volume: string, range?: string): Promise<Response>;
}

export interface OutputConnector {
  save(id: string, turns: SavedAnnotation, meta: { savedAt: string; annotator: string }): Promise<void>;
  load(id: string, annotator: string): Promise<SavedAnnotation | null>;
  listAnnotated(annotator: string): Promise<Set<string>>;
}
