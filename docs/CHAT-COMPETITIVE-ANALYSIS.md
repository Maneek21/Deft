# Chat — Competitive Analysis

> Status note, 2026-06-09: This is a historical comparison against Slack-style team chat. It should not be used as current buyer-facing copy or as a promise to ship native Slack/Gmail/GitHub integrations. Current self-hosted v1 positioning is native Deft workspace + ICS calendars + BYOA/MCP employees.

## Current State

Deft's chat is surprisingly feature-rich. It has most of what Slack offers — threads, reactions, mentions, pins, bookmarks, scheduled messages, audio clips, huddles, DMs, file uploads, link previews, typing indicators, presence, rich text formatting, slash commands, and an integrated AI agent. This is not a prototype — it's a functional team communication tool.

---

## Feature Comparison Matrix

| Feature | Deft | Slack | Discord | WhatsApp | Teams |
|---------|------|-------|---------|----------|-------|
| **Rich text formatting** | B/I/S/Code/Lists/Quotes/Links | B/I/S/Code/Lists/Quotes/Links | Markdown subset | B/I/S/Code | B/I/S/Code/Lists |
| **Threads** | Full (side panel + reply counts) | Full | Forum channels only | Reply-to (quote) | Full |
| **Reactions** | Full (emoji picker) | Full (custom emoji) | Full (custom emoji + super reactions) | 6 preset only | Full |
| **Mentions** | @user + @all | @user @here @channel | @user @role @everyone | @user | @user @team @channel |
| **File upload** | 50MB, any type | 1GB (paid) | 25MB (free) / 500MB (Nitro) | 2GB | 250GB |
| **Link previews** | Auto-unfurl (3 max) | Auto-unfurl | Auto-unfurl | Auto-unfurl | Auto-unfurl |
| **Message editing** | Full with version history | Full (shows "edited") | Full | 15-min window | Full |
| **Message deletion** | Soft delete | Full | Full | "Delete for everyone" | Full |
| **Pinned messages** | Full (pin bar + dropdown) | Full (channel pins) | Full (50 per channel) | None | Full |
| **Bookmarks/Saved** | Full | Full (saved items) | None | Starred messages | Saved messages |
| **Scheduled messages** | Full (presets + custom) | Full | None | None | Full |
| **Audio clips** | Full (record + transcribe) | Huddle clips | None | Voice notes | Voice messages |
| **Huddles/Calls** | WebRTC P2P (audio) | Full (audio + video + screen share) | Full (voice channels) | Full (audio + video) | Full |
| **Typing indicators** | Full | Full | Full | Full | Full |
| **Presence/Online** | Full (online/idle/offline) | Full (online/away/DND) | Full (online/idle/DND/invisible) | Last seen / online | Full |
| **DMs** | 1:1 + Group DMs | Full | Full | Full (primary use) | Full |
| **Search** | Full (with filters) | Full (advanced operators) | Basic | Basic | Full |
| **Slash commands** | 6 built-in | Extensive + app commands | Extensive + bot commands | None | Extensive |
| **AI agent in chat** | Native (auto-reply, classify, extract) | Slack AI (paid add-on) | None | Meta AI (limited) | Copilot (paid) |
| **Canvas/Whiteboard** | Per-space (basic) | Canvas (new feature) | None | None | Whiteboard |
| **Custom emoji** | Upload support | Full (org-wide) | Full (server-wide + Nitro) | None | None |
| **Read receipts** | Thread reads only | None | None | Blue ticks | Blue ticks |
| **Message forwarding** | Not implemented | Share to channel | None | Forward | Forward |
| **Drafts** | Not implemented | Full | None | None | Full |
| **Notification control** | Mute + DND | Full (per-channel, keywords) | Full (per-server, per-channel) | Full | Full |
| **Message encryption** | None | Enterprise (EKM) | None | E2E (default) | E2E (optional) |

---

## Where Deft Stands

### Strengths (Already Ahead)
1. **AI agent is native** — not a bolt-on. Every message feeds the classification pipeline. The agent reads conversations, extracts facts, creates wiki pages, and manages tasks. Slack charges extra for Slack AI. Discord has nothing. WhatsApp has basic Meta AI.
2. **Wiki knowledge graph** — messages become organizational knowledge automatically. No competitor connects chat → knowledge base this way.
3. **Task integration** — `#DEFT-7` in chat links to actual tasks. Agent auto-creates tasks from conversations. Slack needs Asana/Jira integrations.
4. **Audio clips with transcription** — record, transcribe, and summarize. Slack has this in huddles but not as standalone clips in chat.
5. **Message version history** — Deft tracks all edits. Slack just shows "edited".
6. **Scheduled messages with presets** — convenient presets (30min, 1hr, tomorrow 9am).

### Parity (Matching Slack)
- Threads with side panel
- Reactions with emoji picker  
- Rich text editor (TipTap > Slack's editor)
- Pinned messages with pin bar
- Saved/bookmarked messages
- Typing indicators + presence
- DMs and group DMs
- File uploads
- Link previews
- Slash commands
- Canvas/shared documents

### Gaps (Behind Competitors)

| Gap | Impact | Competitor Reference | Effort |
|-----|--------|---------------------|--------|
| **No read receipts in channels** | Users can't see who read their message | WhatsApp blue ticks, Teams "seen by" | Medium |
| **No message forwarding** | Can't share a message to another channel | Slack "Share", WhatsApp forward | Small |
| **No draft auto-save** | Lose typed message if you navigate away | Slack drafts | Medium |
| **Huddles are audio-only P2P** | No video, no screen share, breaks with 3+ people | Slack/Discord/Teams full AV | Large |
| **No notification keywords** | Can't get notified when specific words are mentioned | Slack keyword notifications | Small |
| **No channel-level notification settings** | Only mute/unmute, no "mentions only" option | Slack per-channel notification level | Small |
| **No message reactions with custom emoji** | Only standard Unicode emoji, no org-specific reactions | Slack/Discord custom emoji reactions | Small |
| **No "mark as unread"** | Can't mark a message to come back to later | Slack "Mark unread" | Small |
| **No channel bookmarks/links bar** | No persistent links bar at top of channel | Slack bookmarks bar | Small |
| **No workflow builder** | No visual automation builder | Slack Workflow Builder | Large |
| **No app/bot framework** | No way for third parties to build integrations | Slack apps, Discord bots | Large |

---

## Deft's Unique Advantage

**No competitor has chat + tasks + wiki + AI agent in one app.**

Slack is chat. You need Asana for tasks, Notion for docs, and Slack AI costs extra. Discord is for communities, not work. WhatsApp has no organizational features. Teams has tasks and docs but the AI is a bolt-on copilot, not a native workflow engine.

Deft's chat is the **observation surface for the AI agent**. Every message is classified, facts are extracted, decisions are captured, tasks are created — automatically. The chat isn't just communication, it's the input layer for the organizational brain.

### Concrete advantages:

1. **"Just talk, Deft handles the rest"** — Discuss a decision in chat → agent extracts it → creates wiki page → links to relevant tasks. No manual documentation needed.

2. **@agent in any channel** — Ask the agent questions in context. "What did we decide about auth?" — agent searches wiki + messages + tasks and answers. Slack AI can search but can't take actions.

3. **Cross-reference everything** — Messages reference tasks (#DEFT-7), tasks reference messages, wiki pages cite messages. One connected graph of work.

4. **Smart catch-up** — The "Catch Up" button in the channel header summarizes what you missed. Not just unread count — actual AI summary.

5. **Proactive intelligence** — Agent detects blockers, nudges stalled tasks, generates standups from chat activity. No other chat app does this.

---

## What to Build Next (Priority Order)

### Tier 1: Small Wins (Close Obvious Gaps)

| Feature | What | Effort |
|---------|------|--------|
| **Message forwarding** | "Forward to..." button on message hover → select channel → post with attribution | Small |
| **Mark as unread** | Right-click/long-press option to mark a message as unread in a space | Small |
| **Draft auto-save** | Save composer content to localStorage per space, restore on revisit | Small |
| **Notification keywords** | User settings: list of words that trigger notifications even in muted channels | Small |
| **Per-channel notification level** | "All messages" / "Mentions only" / "Nothing" per channel (not just mute) | Small |
| **Custom emoji reactions** | Allow org-uploaded emoji in reaction picker | Small (emoji upload already exists) |

### Tier 2: Important for Retention

| Feature | What | Effort |
|---------|------|--------|
| **Read receipts** | "Seen by X, Y, Z" on messages. Per-message read tracking. Toggle in settings. | Medium |
| **Channel bookmarks bar** | Persistent links bar below channel header (docs, links, pinned resources) | Medium |
| **Thread summarization** | "Summarize thread" button using Haiku — for long threads | Small (agent infra exists) |
| **Message polls** | `/poll "Question" "Option A" "Option B"` — inline voting in chat | Medium |

### Tier 3: Bigger Bets

| Feature | What | Effort |
|---------|------|--------|
| **Video in huddles** | Add video track to WebRTC huddles | Large |
| **Screen sharing** | Screen capture API + WebRTC | Large |
| **SFU for group calls** | Media server for 3+ participants (P2P breaks at scale) | Large |
| **App/bot framework** | Incoming/outgoing webhooks, bot users, slash command registration | Large |

---

## What NOT to Build

- **Slack Apps marketplace** — Deft's value is integration, not extensibility. Connected tools and BYOA agents cover the core use cases.
- **Discord-style server/role system** — Deft is for small-medium teams, not large communities.
- **E2E encryption** — Not needed for team workspace. Would break agent classification.
- **Stories/status updates** — Wrong metaphor for a work tool.
- **Voice channels (always-on)** — Huddles serve this purpose better for work contexts.

---

## The Pitch

> "Slack is where you talk. Deft is where you talk AND things happen. Every conversation feeds your team's AI agent — decisions get captured, tasks get created, knowledge gets organized. Stop documenting what you discussed. Just discuss it."
