// Worker handler: transcribe clip audio, then summarize with AI agent
import { eq } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { clips, messages, tasks, spaces } from '@deft/db/schema';
import { transcribe } from '../../lib/transcription.js';
import { llm } from '../../lib/llm.js';
import { getOrgAIConfig } from '../../lib/org-ai-config.js';
import { getIO } from '../../socket.js';
import { join } from 'node:path';
import type { JobData } from '../types.js';

const CLIP_DIR = join(process.cwd(), '..', '..', 'uploads', 'clips');

export async function handleClipProcess(job: JobData): Promise<void> {
  const { clip_id, org_id, message_id, space_id, file_key, context_type, context_id, user_id, user_name } = job.data;

  console.log(`[clip-process] Starting clip ${clip_id}`);

  // ─── Step 1: Transcribe ───
  // Transcription is a NICE-TO-HAVE, not a gate. If no provider is configured
  // (OPENAI_API_KEY/DEEPGRAM_API_KEY/WHISPER_URL absent or rejecting), the audio
  // clip itself is still the primary artifact — users should be able to record
  // and play back voice messages without needing an AI provider. Slack/Discord
  // ship voice clips with no transcription by default. Only if transcription
  // SUCCEEDS do we run summarization and emit transcript/segments.
  let transcription: { text: string; segments: any[]; duration_s: number; model: string } | null = null;
  try {
    await db.update(clips)
      .set({ status: 'transcribing' })
      .where(eq(clips.id, clip_id));

    const audioPath = join(CLIP_DIR, file_key);
    transcription = await transcribe(audioPath, org_id);

    await db.update(clips)
      .set({
        transcript: transcription.text,
        segments: transcription.segments,
        duration_s: Math.round(transcription.duration_s) || undefined,
        whisper_model: transcription.model,
        status: 'summarizing',
      })
      .where(eq(clips.id, clip_id));

    console.log(`[clip-process] Transcription done for ${clip_id}: ${transcription.text.length} chars`);
  } catch (err) {
    console.warn(`[clip-process] Transcription unavailable for ${clip_id}, shipping audio-only:`, (err as Error).message);
    // Mark the failure cause but ALSO mark the clip as playable. Step 4 below
    // sets status='ready' regardless, so the message becomes a normal clip
    // card and the user can play it back.
    await db.update(clips)
      .set({
        error: `Transcription unavailable: ${(err as Error).message}`,
        status: 'summarizing', // skip ahead — Step 3 will detect null transcription and skip too
      })
      .where(eq(clips.id, clip_id));
  }

  // ─── Step 2: Gather context ───
  let contextTitle = '';
  let contextDescription = '';

  try {
    if (context_type === 'task') {
      const [task] = await db.select({ title: tasks.title, description: tasks.description })
        .from(tasks).where(eq(tasks.id, context_id)).limit(1);
      if (task) {
        contextTitle = task.title;
        contextDescription = task.description || '';
      }
    } else if (context_type === 'space') {
      const [space] = await db.select({ name: spaces.name, description: spaces.description })
        .from(spaces).where(eq(spaces.id, context_id)).limit(1);
      if (space) {
        contextTitle = space.name;
        contextDescription = space.description || '';
      }
    } else if (context_type === 'thread') {
      // context_id is the parent message ID
      const [parentMsg] = await db.select({ content: messages.content })
        .from(messages).where(eq(messages.id, context_id)).limit(1);
      if (parentMsg) {
        contextTitle = parentMsg.content.replace(/<[^>]+>/g, '').slice(0, 100);
      }
    }
  } catch {
    // Non-critical, continue without context
  }

  // ─── Step 3: AI Summarization ───
  let summary = { tldr: '', decisions: [] as string[], actions: [] as string[], blockers: [] as string[] };

  if (transcription && transcription.text.length > 30) {
    try {
      const systemPrompt = `You are an AI assistant analyzing an audio clip recorded in a team workspace.
The clip was recorded by ${user_name} in context: ${context_type} "${contextTitle}".
${contextDescription ? `Context description: ${contextDescription}` : ''}

Analyze the transcript and return a JSON object with exactly these fields:
- tldr: A 2-3 sentence summary of what was said
- decisions: Array of decisions made (strings). Empty array if none.
- actions: Array of action items mentioned (strings like "Update docs → @riya"). Empty array if none.
- blockers: Array of blockers or concerns raised (strings). Empty array if none.

Return ONLY valid JSON, no markdown fences, no extra text.`;

      const orgConfig = await getOrgAIConfig(org_id);
      const result = await llm({
        task: 'summarize',
        system: systemPrompt,
        messages: [{ role: 'user', content: transcription.text }],
        maxTokens: 500,
        orgConfig,
      });

      try {
        const parsed = JSON.parse(result.text);
        summary = {
          tldr: parsed.tldr || '',
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
        };
      } catch {
        // If JSON parse fails, use the raw text as tldr
        summary.tldr = result.text.slice(0, 300);
      }

      console.log(`[clip-process] Summary done for ${clip_id}`);
    } catch (err) {
      console.warn(`[clip-process] Summarization failed for ${clip_id}:`, err);
      summary.tldr = transcription.text.slice(0, 200) + (transcription.text.length > 200 ? '...' : '');
    }
  } else if (transcription) {
    summary.tldr = transcription.text || 'Short clip — no summary generated.';
  } else {
    // No transcription provider available. Audio still ships as a playable clip.
    summary.tldr = '';
  }

  // ─── Step 4: Update clip record ───
  await db.update(clips)
    .set({ summary, status: 'ready' })
    .where(eq(clips.id, clip_id));

  // ─── Step 5: Update the message with the clip card content ───
  await updateClipMessage(message_id, clip_id, 'ready', space_id, {
    summary,
    transcript: transcription?.text || '',
    duration_s: transcription ? Math.round(transcription.duration_s) : 0,
    user_name,
  });

  console.log(`[clip-process] Clip ${clip_id} fully processed`);
}

async function updateClipMessage(
  messageId: string,
  clipId: string,
  status: string,
  spaceId: string,
  data?: { summary: any; transcript: string; duration_s: number; user_name: string },
) {
  const content = status === 'ready'
    ? `[[clip:${clipId}:ready]]`
    : `[[clip:${clipId}:${status}]]`;

  const metadata = status === 'ready' && data
    ? {
        clip_id: clipId,
        clip_status: 'ready',
        clip_summary: data.summary,
        clip_duration_s: data.duration_s,
        clip_user_name: data.user_name,
        clip_has_transcript: data.transcript.length > 0,
      }
    : { clip_id: clipId, clip_status: status };

  await db.update(messages)
    .set({ content, metadata })
    .where(eq(messages.id, messageId));

  // Broadcast the edit so clients update in real time
  const io = getIO();
  io?.to(`space:${spaceId}`).emit('message:edited', {
    id: messageId,
    content,
    edited_at: null, // not a user edit
    metadata,
  });
}
