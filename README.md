# Claudex

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

   # Optional — enables GitHub comment mentions (see below)
   GITHUB_TOKEN=github_pat_...
   GITHUB_WEBHOOK_SECRET=...      # shared secret configured in your GitHub App
   GITHUB_BOT_HANDLE=@claudex     # mention string Claude watches for (default: @claudex)
   GITHUB_WEBHOOK_PORT=8080       # HTTP port for the webhook server (default: 8080)
   ```

3. **Slack app setup** — import `slack-manifest.json` into your Slack app config. The app needs Socket Mode enabled and the scopes listed in the manifest.

4. **(Optional) GitHub App setup** — to enable `@claudex` mentions in GitHub issues/PRs:
   - Create a GitHub App (or use a fine-grained PAT) with `issues: write` permission on the target repos
   - Add a webhook pointing at `https://your-host:8080/github/webhook`, subscribed to **Issue comments** events
   - Set `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and optionally `GITHUB_BOT_HANDLE` in your `.env`
   - The HTTP server starts automatically alongside the Slack Socket Mode connection when `GITHUB_TOKEN` is present

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

### GitHub channel (optional)

When `GITHUB_TOKEN` is set, Claudex also starts a lightweight HTTP server that receives GitHub webhooks. Mentioning `@claudex` (or whatever `GITHUB_BOT_HANDLE` is set to) in a GitHub issue or PR comment triggers the same Claude Code session infrastructure used for Slack. Sessions are keyed by `gh:{owner/repo}#{issue_number}`, so context persists across the full issue/PR thread — the same way it does per Slack thread. Responses are posted back as GitHub comments.

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
  github/
    handler.ts          # webhook HTTP server, signature verification, session routing
    post.ts             # post comments back to GitHub via REST API
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
