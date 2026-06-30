import type {
  Conversation,
  ConversationMeta,
  InputConnector,
} from "./types";

// A fully self-contained input connector for trying the tool with no backend.
// Returns one synthetic conversation with harmless placeholder transcripts and
// a generated audio clip (two short tone "bursts" so the waveform looks alive).
// Run with: ANNOTATE_INPUT=demo bun run dev

const DEMO_ID = "conv_demo_0001";
const DEMO_VOLUME = "demo";
const DURATION_SEC = 12;

// Two "speech" regions; everything else is silence.
const BURSTS = [
  { start: 1.0, end: 3.0 },
  { start: 6.0, end: 9.0 },
];

const TURNS = [
  { start: 1.0, end: 3.0, text: "Hi, this is a demo conversation." },
  { start: 6.0, end: 9.0, text: "My name is Alex, spelled A L E X. My ID is 12345." },
];

// ── synthetic 16-bit PCM mono WAV ──────────────────────────────────────────
let cachedWav: Uint8Array | null = null;
function demoWav(): Uint8Array {
  if (cachedWav) return cachedWav;
  const sampleRate = 16000;
  const numSamples = DURATION_SEC * sampleRate;
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = 0;
    for (const b of BURSTS) {
      if (t >= b.start && t <= b.end) {
        const env = Math.sin((Math.PI * (t - b.start)) / (b.end - b.start)); // fade in/out
        const wobble = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t); // speech-like modulation
        amp = env * wobble;
      }
    }
    const sample = amp * Math.sin(2 * Math.PI * 220 * t) * 0.6;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  cachedWav = new Uint8Array(buf);
  return cachedWav;
}

export class DemoInputConnector implements InputConnector {
  async list(): Promise<ConversationMeta[]> {
    return [
      {
        id: DEMO_ID,
        volume: DEMO_VOLUME,
        group: "demo",
        durationSeconds: DURATION_SEC,
        hasAnnotation: false,
      },
    ];
  }

  async get(): Promise<Conversation> {
    return {
      id: DEMO_ID,
      volume: DEMO_VOLUME,
      audioUrl: `audio/${DEMO_ID}?volume=${DEMO_VOLUME}`,
      groundTruth: {
        intervals: BURSTS.map((b) => ({ start: b.start, end: b.end, label: "speech" })),
      },
      humanAnnotation: {
        intervals: BURSTS.map((b) => ({ start: b.start, end: b.end })),
      },
      sourceTranscript: {
        text: TURNS.map((t) => t.text).join(" "),
        interval_transcripts: TURNS.map((t) => ({ start: t.start, end: t.end, text: t.text })),
      },
      turnTranscripts: {
        turns: TURNS.map((t) => ({ start: t.start, end: t.end, text: t.text })),
      },
    };
  }

  async getAudio(): Promise<Response> {
    return new Response(demoWav(), {
      status: 200,
      headers: { "content-type": "audio/wav", "accept-ranges": "bytes" },
    });
  }
}
