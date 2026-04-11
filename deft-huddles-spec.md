# Deft AI — Huddle System Spec

**Status:** Planning  
**Scope:** Two modes — Async Clip + Live Huddle  
**AI Layer:** Shared across both modes  

---

## Overview

Deft huddles are contextual, AI-processed voice and video exchanges attached to workspace entities (tasks, threads, projects). Unlike Slack Huddles (floating rooms) or Loom (standalone clips), every Deft huddle is anchored to a piece of work — and the AI agent processes both modes identically, turning conversations into structured workspace artifacts.

Two modes:

| | Async Clip | Live Huddle |
|---|---|---|
| **When** | People aren't online simultaneously | Real-time sync needed |
| **Input** | Record audio / video / screen | WebRTC audio + video |
| **Output** | Transcript + summary + tasks, posted to context | Same, posted when huddle ends |
| **Complexity** | Ship first | Ship second |
| **Dependency** | Whisper, storage | mediasoup/simple-peer + Whisper |

---

## Part 1: Async Clip

### What it is

A Loom-style in-context recording. Any user can record a short audio, video, or screen-share clip from within any task, thread, or project view. The clip is stored on the self-hosted server, transcribed automatically, summarized by the Deft AI agent, and posted as a structured card in the originating context. Recipients can reply with text or their own clip.

---

### User flow

```
User opens a task or thread
  → Clicks the mic/camera icon (or ⌘+H)
  → Selects "Async Clip"
  → Countdown (3s) → Recording starts
  → Records up to 5 minutes
  → Clicks Stop
  → Upload + processing begins (non-blocking, spinner in thread)
  → AI agent posts summary card to thread within ~30s
  → Participants are notified
  → Replies can be text or another clip (threaded)
```

---

### Entry points

| Location | Trigger | Context attached |
|---|---|---|
| Task card | Mic icon in task header | Task ID, assignees, status |
| Thread | Clip button in message composer | Thread ID, recent messages |
| Project sidebar | Huddle icon next to project name | Project ID |
| Global | ⌘ + H anywhere | Prompts to select context |

---

### Recording options

| Option | Default | Notes |
|---|---|---|
| Audio only | Yes | Smallest file, fastest processing |
| Audio + webcam | Off | PiP overlay, 360p sufficient |
| Screen + audio | Off | Full screen or window selection |
| Max duration | 5 min | Configurable by workspace admin |
| Auto-stop on silence | Off | Optional, threshold configurable |

---

### Processing pipeline

```
Raw recording (webm/opus)
  → Upload to self-hosted storage (S3-compatible or local)
  → Whisper (local, base or small model) → raw transcript
  → Deft AI agent receives:
      - transcript
      - context object (task/thread/project data)
      - participants list
  → Agent produces:
      - 2-3 sentence TL;DR summary
      - Decisions list (if any)
      - Action items with suggested assignees
      - Blockers flagged (if mentioned)
  → Structured card posted to originating thread
  → Clip stored with searchable transcript index
```

---

### Output card (posted to thread)

```
┌─────────────────────────────────────────────────┐
│  🎙 Async clip · Maneek · 2m 14s               │
│  Re: Task #142 — Auth flow redesign             │
├─────────────────────────────────────────────────┤
│  Summary                                        │
│  Maneek walkthrough of the OAuth callback       │
│  issue. Decision: use PKCE flow. One action     │
│  item created.                                  │
├─────────────────────────────────────────────────┤
│  ✅ Decision: Switch to PKCE for OAuth          │
│  📌 Action: Update auth docs → @riya (due Fri)  │
├─────────────────────────────────────────────────┤
│  [▶ Play]  [📄 Transcript]  [↩ Reply]           │
└─────────────────────────────────────────────────┘
```

---

### Threaded replies

- Text replies inline (standard message)
- Clip replies: same record flow, nested under parent clip
- AI does not re-summarize replies unless they are >60s
- All clips in a thread are collapsible into a "Clip thread" view

---

### Storage and search

- Files stored as `clips/{workspace_id}/{clip_id}.webm`
- Transcripts indexed in Deft's search (same index as messages/tasks)
- Clips surfaced in task activity feed, thread timeline, and search results
- Retention policy set per workspace (default: 90 days)

---

### Self-hosted requirements

| Component | Choice | Notes |
|---|---|---|
| Storage | S3-compatible (MinIO default) or local disk | Configured in docker-compose |
| Transcription | Whisper (self-hosted, `base` model) | `small` for better accuracy if GPU available |
| AI summarization | Deft AI agent (existing) | Reuses agent infra already in Deft |
| Browser API | MediaRecorder API | No plugin required, works in all modern browsers |

---

### Admin settings

- Max clip duration (1–10 min)
- Storage location (local / S3 endpoint + credentials)
- Whisper model size (tiny / base / small)
- Auto-delete policy (days)
- Disable clip replies (if org wants clips to be top-level only)

---

### What to build (sprint breakdown)

**Sprint 1 — Core clip (audio only)**
- [ ] MediaRecorder integration in composer
- [ ] Upload endpoint (`POST /api/clips`)
- [ ] Whisper transcription worker (queue-based)
- [ ] Summary card component
- [ ] Post card to thread on completion
- [ ] Play + transcript view

**Sprint 2 — Video + screen**
- [ ] Webcam overlay (PiP)
- [ ] Screen capture (getDisplayMedia)
- [ ] Recording options UI

**Sprint 3 — Replies + search**
- [ ] Threaded clip replies
- [ ] Clip transcript indexed in search
- [ ] Clip activity in task timeline

---

## Part 2: Live Huddle

### What it is

A one-click, real-time audio/video room anchored to a workspace context. No scheduling, no calendar invite. Anyone in the workspace can see who's in a huddle and join. The Deft AI agent silently transcribes the session in real time and, when the huddle ends, posts the same structured output card as the async clip mode.

---

### User flow

```
User is in a task, thread, or project
  → Clicks "Start huddle" (or ⌘+H → Live)
  → Room is created instantly (WebRTC)
  → Presence indicator appears in sidebar:
      "🟢 Huddle in #auth-flow — Maneek"
  → Others can click to join (one click, no permissions prompt)
  → Session runs
  → Any participant clicks "End" (or last person leaves)
  → AI agent processes transcript
  → Summary card posted to originating thread
  → Room is destroyed
```

---

### Presence model

- Active huddles surface in the left sidebar under the relevant project or thread
- Floating indicator: avatar stack + room name + duration
- "Join" is a single click — no confirmation modal, no mic permission re-prompt if already granted
- Muted-by-default on join (configurable per workspace)
- Max participants: 25 per room (mediasoup SFU; configurable)

---

### Room lifecycle

| State | Description |
|---|---|
| `idle` | No huddle in context |
| `active` | ≥1 participant, timer running |
| `ending` | Last participant left, 30s grace period (rejoin window) |
| `processing` | Agent summarizing, card being generated |
| `archived` | Card posted, room destroyed |

---

### In-room UI

Minimalist — huddles are lightweight by design:

```
┌────────────────────────────────────┐
│  🟢 Huddle · #auth-flow · 4:23    │
│                                    │
│  [Maneek 🎙] [Riya 🔇] [Dev 🎙]   │
│                                    │
│  [🔇 Mute]  [📷 Cam]  [🖥 Share]  [✕ Leave] │
└────────────────────────────────────┘
```

- Video is off by default, toggled per participant
- Screen share replaces video tile
- No grid view — avatar row only (keeps it lightweight, not a Zoom clone)
- Persistent chat panel (text during huddle, folded into thread after)

---

### Real-time transcription

- Whisper runs in streaming mode (via `whisper-streaming` or `faster-whisper`)
- Transcript visible in collapsible panel during huddle ("live notes")
- Agent can be @-mentioned mid-huddle to surface task context or answer questions
- Transcript segments saved every 30s (crash recovery)

---

### Processing pipeline (same as async clip, different input)

```
Live audio streams (per participant, mixed server-side)
  → Real-time Whisper → rolling transcript
  → On huddle end:
      - Full transcript assembled
      - Deft AI agent receives transcript + context
      - Produces: TL;DR, decisions, action items, blockers
      - Posts structured card to originating thread
      - Recording (optional) stored same as async clip
```

---

### Output card (identical format to async clip)

```
┌─────────────────────────────────────────────────┐
│  🟢 Live huddle · 3 participants · 18m 42s     │
│  Re: Task #142 — Auth flow redesign             │
├─────────────────────────────────────────────────┤
│  Summary                                        │
│  Team aligned on PKCE migration. Riya takes     │
│  docs update. Dev to open PR by Thursday.       │
├─────────────────────────────────────────────────┤
│  ✅ Decision: PKCE flow confirmed               │
│  📌 Action: Update docs → @riya (Thu)           │
│  📌 Action: Open migration PR → @dev (Thu)      │
│  🚧 Blocker: Needs security review sign-off     │
├─────────────────────────────────────────────────┤
│  [📄 Transcript]  [▶ Recording]  [↩ Reply]      │
└─────────────────────────────────────────────────┘
```

---

### Self-hosted requirements

| Component | Choice | Notes |
|---|---|---|
| WebRTC SFU | mediasoup (preferred) or simple-peer (P2P, <6 users) | mediasoup needs Node.js server process |
| Signaling | WebSocket (existing Deft WS infrastructure) | Reuse existing connection |
| TURN server | coturn (self-hosted) | Needed for NAT traversal |
| Transcription | faster-whisper (streaming mode) | Requires more CPU; GPU preferred |
| Recording (optional) | Server-side mix via mediasoup | Stored same as async clips |

---

### mediasoup vs simple-peer decision

Use **simple-peer (P2P)** if:
- Expected team size <6
- Simpler infra is preferred
- No dedicated server resources

Use **mediasoup (SFU)** if:
- Teams of 6–25
- Server-side recording needed
- Bandwidth efficiency matters

Recommendation: ship with simple-peer first, migrate to mediasoup when teams grow.

---

### Admin settings

- Max room participants
- Recording on/off (compliance use case)
- Muted-by-default on join
- Auto-end huddle after N minutes of silence
- TURN server credentials
- Transcription model size

---

### What to build (sprint breakdown)

**Sprint 1 — Core WebRTC room (audio only)**
- [ ] mediasoup or simple-peer server setup
- [ ] Signaling via existing WebSocket
- [ ] Room creation + join API
- [ ] In-room UI (avatar row, mute, leave)
- [ ] Presence indicator in sidebar
- [ ] Grace period + room teardown

**Sprint 2 — Transcription + AI output**
- [ ] faster-whisper streaming integration
- [ ] Live transcript panel in room
- [ ] Post-huddle agent processing
- [ ] Summary card component (reuse async clip card)

**Sprint 3 — Video + screen share**
- [ ] Webcam tiles
- [ ] Screen share (replaces tile)
- [ ] Recording (optional, admin toggle)

**Sprint 4 — Polish**
- [ ] @agent mid-huddle mentions
- [ ] TURN server + NAT traversal testing
- [ ] Mobile browser support (WebRTC constraints)
- [ ] Reconnect handling

---

## Shared: AI Agent Context Object

Both modes pass the same context object to the agent:

```json
{
  "huddle_id": "hdl_abc123",
  "mode": "async_clip | live",
  "context_type": "task | thread | project",
  "context_id": "task_142",
  "context_title": "Auth flow redesign",
  "context_description": "...",
  "participants": [
    { "id": "usr_1", "name": "Maneek" },
    { "id": "usr_2", "name": "Riya" }
  ],
  "transcript": "...",
  "duration_seconds": 1122,
  "recorded_at": "2026-04-03T10:00:00Z"
}
```

Agent system prompt instructs it to:
1. Read context title + description before summarizing
2. Surface only decisions and action items with high confidence
3. Suggest assignees from participant list
4. Flag blockers as a distinct category
5. Keep TL;DR to 2–3 sentences max

---

## Shared: Data Model

```
clips
  id            uuid pk
  workspace_id  uuid fk
  context_type  enum (task, thread, project)
  context_id    uuid
  mode          enum (async, live)
  created_by    uuid fk (users)
  duration_s    int
  file_path     text
  transcript    text
  summary       jsonb  { tldr, decisions[], actions[], blockers[] }
  participants  jsonb  []
  created_at    timestamp
  deleted_at    timestamp (soft delete)

clip_replies
  id            uuid pk
  clip_id       uuid fk (clips)
  user_id       uuid fk
  type          enum (text, clip)
  content       text (if text)
  clip_id_ref   uuid fk (clips, if clip reply)
  created_at    timestamp
```

---

## Build order recommendation

1. **Async Clip, audio only** — highest value, lowest infra complexity. Ships in 1–2 sprints.
2. **Async Clip, video + screen** — additive, same pipeline.
3. **Live Huddle, audio + transcription** — WebRTC infra lift, but reuses all AI/card components.
4. **Live Huddle, video + recording** — final polish layer.

The async clip is the 80% use case. Most quick syncs don't need everyone live simultaneously. Ship it first, validate the AI output card format, then the live huddle builds on a proven foundation.
