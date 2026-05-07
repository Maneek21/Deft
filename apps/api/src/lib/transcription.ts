// Unified transcription provider — supports local Whisper, OpenAI Whisper API, Deepgram.
// Provider precedence: per-org config (`orgs.ai_config.transcription.provider`)
// → env.TRANSCRIPTION_PROVIDER (defaults to 'local').
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { orgs } from '@deft/db/schema';
import { env } from './env.js';
import { readFile } from 'node:fs/promises';

export type TranscriptSegment = {
  start: number; // seconds
  end: number;
  text: string;
  speaker?: string;
};

export type TranscriptionResult = {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  model: string;
  duration_s: number;
};

// ─── Local Whisper (self-hosted faster-whisper container) ───
async function transcribeLocal(audioPath: string): Promise<TranscriptionResult> {
  const fileBuffer = await readFile(audioPath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), 'audio.webm');
  formData.append('response_format', 'verbose_json');

  const res = await fetch(`${env.WHISPER_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Local Whisper failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    text: string;
    segments?: { start: number; end: number; text: string }[];
    language?: string;
    duration?: number;
  };

  return {
    text: data.text || '',
    segments: (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })),
    language: data.language,
    model: 'whisper-local',
    duration_s: data.duration || 0,
  };
}

// ─── OpenAI Whisper API ───
async function transcribeOpenAI(audioPath: string): Promise<TranscriptionResult> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set for transcription');

  const fileBuffer = await readFile(audioPath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), 'audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`OpenAI Whisper failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    text: string;
    segments?: { start: number; end: number; text: string }[];
    language?: string;
    duration?: number;
  };

  return {
    text: data.text || '',
    segments: (data.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })),
    language: data.language,
    model: 'whisper-1',
    duration_s: data.duration || 0,
  };
}

// ─── Deepgram ───
async function transcribeDeepgram(audioPath: string): Promise<TranscriptionResult> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not set for transcription');

  const fileBuffer = await readFile(audioPath);

  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&punctuate=true', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/webm',
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Deepgram failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as any;
  const channel = data.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const words = alt?.words || [];

  // Build segments from utterances or word groups
  const utterances = data.results?.utterances || [];
  const segments: TranscriptSegment[] = utterances.length > 0
    ? utterances.map((u: any) => ({
        start: u.start,
        end: u.end,
        text: u.transcript.trim(),
        speaker: u.speaker !== undefined ? `Speaker ${u.speaker}` : undefined,
      }))
    : words.length > 0
      ? [{ start: words[0].start, end: words[words.length - 1].end, text: alt.transcript }]
      : [];

  return {
    text: alt?.transcript || '',
    segments,
    language: channel?.detected_language,
    model: 'deepgram-nova-2',
    duration_s: data.metadata?.duration || 0,
  };
}

type StoredTranscriptionConfig = {
  transcription?: { provider?: 'local' | 'openai' | 'deepgram' };
};

async function resolveProvider(orgId: string | null | undefined): Promise<'local' | 'openai' | 'deepgram'> {
  if (orgId) {
    try {
      const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
      const cfg = (row?.ai_config ?? {}) as StoredTranscriptionConfig;
      const p = cfg.transcription?.provider;
      if (p === 'local' || p === 'openai' || p === 'deepgram') return p;
    } catch {
      // fall through to env
    }
  }
  return env.TRANSCRIPTION_PROVIDER;
}

// ─── Public API ───
export async function transcribe(audioPath: string, orgId?: string | null): Promise<TranscriptionResult> {
  const provider = await resolveProvider(orgId);

  switch (provider) {
    case 'local':
      return transcribeLocal(audioPath);
    case 'deepgram':
      return transcribeDeepgram(audioPath);
    case 'openai':
    default:
      return transcribeOpenAI(audioPath);
  }
}
