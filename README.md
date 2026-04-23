# TwinMind Meeting Copilot

Real-time meeting copilot web app with live microphone transcription, context-aware suggestions, and follow-up chat.

## Overview

The app captures mic audio in rolling chunks, transcribes with Groq Whisper, generates exactly 3 live suggestions per refresh window, and supports detailed chat responses from clicked suggestions or typed questions.

Session state is in-memory and exportable as JSON for analysis.

## Tech Stack

- Frontend: React + TypeScript + Vite
- Backend: Node.js + Express
- AI models (Groq):
  - Transcription: `whisper-large-v3`
  - Suggestions + Chat: `openai/gpt-oss-120b`

## Core Functionality

- Start/stop microphone recording
- Transcript updates in ~30s chunks with auto-scroll
- Manual transcript refresh while recording
- Live suggestions:
  - exactly 3 items per batch
  - newest batch first
  - tappable cards by type (`question`, `talking-point`, `answer`, `fact-check`, `clarification`)
- Chat:
  - one continuous session thread
  - supports clicked-suggestion and typed input
  - tag-aware responses for clicked suggestion intents
- Settings:
  - API key input
  - editable system prompts
  - context-window controls
  - reset-to-defaults and save workflow
- Export:
  - transcript + all suggestion batches + chat history + timestamps + settings

## Prompting and Guardrails

- Recency-biased context for suggestions
- Duplicate and near-duplicate suppression across batches
- Low-signal transcript fallback handling
- Strict transcript grounding for chat and suggestion generation
- Tag-specific chat behavior for suggestion clicks (e.g., question/fact-check/talking-point)
- Safe fallback handling for missing context

## Local Development

1. Install dependencies:
   - `npm install`
2. Start frontend + backend:
   - `npm run dev`
3. Open:
   - `http://localhost:5173`
4. Paste your Groq API key in the app settings.

## Scripts

- `npm run dev` - run frontend and backend concurrently
- `npm run dev:client` - run Vite frontend only
- `npm run dev:server` - run Express API only
- `npm run build` - type-check + production build
- `npm run lint` - run ESLint

## API Endpoints

- `GET /api/health` - health check
- `POST /api/transcribe` - audio chunk -> transcript text
- `POST /api/suggestions` - transcript context -> 3 suggestion batch
- `POST /api/chat` - chat turn response using transcript + history

## Configuration

- Runtime server port:
  - `PORT` (optional, default `8787`)
- API keys are user-provided at runtime via settings UI (not hard-coded in codebase).

## Deployment Notes

- Deploy over HTTPS (browser mic permission requires secure context in most environments).
- Ensure frontend can reach backend routes (`/api/*`) in production.
- Verify end-to-end flow with a fresh Groq key:
  - transcript capture
  - suggestion generation
  - chat response
  - session export

