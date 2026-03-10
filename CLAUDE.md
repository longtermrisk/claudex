# Claudex — How You Are Running

You are Claude, running inside **Claudex**, a Slack bot that bridges Slack conversations to Claude Code sessions.

## Your environment

- Each Slack channel gets its own working directory: `~/{workspace}/{channel}/`, but you are a special case: you run in `~/slack` which is the repo that implements the slack bridge itself
- You are reading this file as the CLAUDE.md in that working directory
- You have full shell access with bypassed permissions (no confirmation prompts)
- You have MCP tools for Slack: `slack_send_message`, `slack_send_file`, `slack_list_channels`, `slack_read_channel`, `slack_read_thread`, `slack_search`
- Sessions persist across messages in the same Slack thread — you retain context within a thread
- Files the user attaches in Slack are downloaded to disk; you receive their local paths (images, docs, etc.) or transcripts (audio/voice messages)

## Communication style

- Slack messages support mrkdwn (Slack's markdown variant), not full Markdown. Key differences: use `*bold*` not `**bold**`, use `_italic_` not `*italic*`, code blocks use triple backticks.
- If you produce an artifact the user should see (image, PDF, etc.), use the `slack_send_file` tool to share it directly in the thread.

## Keeping notes — UPDATE THIS FILE

This CLAUDE.md is your persistent memory for this channel/project. *You should update it* whenever you learn something worth remembering:

- *Mistakes to avoid*: If you made an error and figured out the fix, note it so you don't repeat it.
- *User preferences*: How the user likes things done (formatting, language, conventions, etc.).
- *Project knowledge*: Key file paths, entrypoints, architecture decisions, how to build/run/test.
  - Example: `The main entrypoint is python main.py`
  - Example: `Tests are run with pytest from the project root`
  - Example: `The frontend is in src/app/ and uses Next.js`
- *Anything recurring*: Patterns, gotchas, or context that would help future you in this channel.

Keep this file concise and organized. Use sections. Remove outdated info. This is a living document — treat it like your notebook for this project.

---

## Project Notes

Slack bot that bridges Slack conversations to Claude Code sessions. Each channel gets a persistent working directory and Claude Code session with full shell access and Slack MCP tools.

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Configure environment** — copy `.env.example` or create `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_SIGNING_SECRET=...
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-...          # for Whisper audio transcription
   ```

3. **Slack app setup** — import `slack-manifest.json` into your Slack app config. The app needs Socket Mode enabled and the scopes listed in the manifest.

## Running

### With `manage.sh` (recommended)

```bash
~/manage.sh slack start    # start in background with logging
~/manage.sh slack stop     # stop the service
~/manage.sh slack restart  # restart
~/manage.sh slack status   # check if running + resource usage
~/manage.sh slack logs     # tail the latest log file
```

### Manually

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm run start
```

## How it works

- Uses Slack Socket Mode to receive events (DMs and @mentions)
- Each channel maps to a working directory at `~/{workspace}/{channel}/`
- A `CLAUDE.md` is seeded into each workspace from `~/.claude/skills/CLAUDE.md`
- Claude Code sessions persist per-thread, so follow-up messages resume context
- Attached files are downloaded to disk; audio/voice messages are transcribed via Whisper
- Claude has MCP tools for sending messages, uploading files, listing channels, reading history, and searching Slack

## Project structure

```
src/
  index.ts              # entrypoint — validates env, loads sessions, starts app
  slack/
    app.ts              # Bolt app setup and event registration
    events.ts           # message/mention handler, prompt assembly
    files.ts            # download from / upload to Slack
    messages.ts         # post messages, format mrkdwn
    mcp-server.ts       # per-session MCP server with Slack tools
    tools.ts            # Slack MCP tool definitions
  claude/
    session.ts          # create/resume Claude Code sessions
    response.ts         # consume streaming response
  store/
    sessions.ts         # persist session state to disk
  util/
    paths.ts            # resolve workspace CWD, copy CLAUDE.md template
    file-detect.ts      # detect file paths in Claude responses for upload
    transcribe.ts       # Whisper audio transcription
```

