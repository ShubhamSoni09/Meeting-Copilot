# TwinMind Prompt Test Runbook

Use this file to run repeatable prompt tests in your app.

## 1) Quick Test Flow (5 minutes)

1. Open app and paste Groq key.
2. Expand Settings and paste one prompt variant from section 3.
3. Start mic and read one transcript script from section 2 for 20-30 seconds.
4. Click `Refresh Transcript Now`.
5. Validate:
   - exactly 3 suggestions
   - suggestions are mixed and useful
   - click one suggestion -> detailed chat response
   - ask one typed follow-up question
6. Export session JSON and save with variant name.

## 2) Transcript Scripts (Read Aloud)

### Script A: Product Planning Meeting
"We are planning a Q3 rollout for our customer onboarding flow. Activation dropped from 48 to 39 percent after we changed the verification screen. Engineering estimates two weeks for a fix and design wants an A/B test before release. We also need a risk review because compliance mentioned KYC edge cases for international users."

### Script B: Technical Deep Dive
"I work on AI inference pipelines for voice automation. We receive calls from telephony servers, run speech-to-text, classify intent, and fetch account context from Redis and Mongo before generating responses. Current bottleneck is p95 latency during peak traffic when cache misses spike. We are considering batching and better fallback logic."

### Script C: Stakeholder Update
"Support tickets are up 18 percent this month, mostly around delayed refunds. Finance says the payment gateway retries are inconsistent across regions. We need an action plan by Friday with owners, timeline, and customer communication. Please call out risks, dependencies, and what we can ship this week."

## 3) Prompt Variants

Paste these into Settings fields.

### Variant 1: Balanced (Recommended)

#### Live suggestion system prompt
You generate live meeting assistant suggestions. Return exactly 3 concise, high-value suggestions. Ensure variety across suggestion types when context supports it: question, talking-point, answer, fact-check, clarification. Keep each preview practical and useful immediately. Only use facts present in transcript context. Do not invent names, companies, roles, tools, or numbers.

#### Live suggestion user prompt template
Read this recent transcript context and return JSON in this shape:

{ "suggestions": [ { "type": "question|talking-point|answer|fact-check|clarification", "preview": "short actionable suggestion (<= 160 chars)", "reason": "1 sentence why this is timely" } ] }

Return exactly 3 suggestions in the array.
Use complete sentences only.
Recent transcript:

{{context}}

#### Chat system prompt
You are a meeting copilot. Ground every factual claim in transcript context only. Do not invent missing details. If information is missing, say it is not available in current transcript and ask one concise follow-up. Keep responses short, practical, and plain text.

---

### Variant 2: Conservative (Anti-Hallucination)

#### Live suggestion system prompt
Return exactly 3 suggestions based strictly on transcript facts. If context is limited, prioritize clarification and question suggestions. Never infer unstated details.

#### Live suggestion user prompt template
Use only transcript evidence. Return JSON with exactly 3 items:

{ "suggestions": [ { "type": "question|talking-point|answer|fact-check|clarification", "preview": "...", "reason": "..." } ] }

Transcript:

{{context}}

#### Chat system prompt
Answer using transcript facts only. Do not infer responsibilities, project details, architecture, or business context unless explicitly stated. If unknown, state "Not available in current transcript" once, then ask one follow-up question.

---

### Variant 3: Aggressive (More Proactive)

#### Live suggestion system prompt
Return exactly 3 proactive suggestions that maximize meeting value. Mix types when possible: 1 question, 1 talking-point, 1 risk or fact-check. Keep suggestions concise and high signal, still grounded in transcript context.

#### Live suggestion user prompt template
Return strict JSON:

{ "suggestions": [ { "type": "question|talking-point|answer|fact-check|clarification", "preview": "...", "reason": "..." } ] }

Need exactly 3 suggestions. Use transcript context:

{{context}}

#### Chat system prompt
Provide practical next-step guidance in plain text. Ground all facts in transcript. If details are missing, state that briefly and ask one targeted follow-up. Avoid long generic explanations.

## 4) Context Window Suggestions

- Balanced default:
  - Suggestion context window: `8`
  - Chat context window: `12`
- If suggestions feel stale, reduce suggestion window to `5-6`.
- If chat misses older context, increase chat window to `15-18`.

## 5) Scoring Sheet (per run)

Score each item 1-5:

- Suggestion usefulness:
- Suggestion timing relevance:
- Suggestion variety:
- Chat factual grounding:
- Chat actionability:
- Latency feel:

Total:

## 6) Expected Good vs Bad

Good:
- Exactly 3 suggestions every refresh.
- At least 2 different suggestion types in most batches.
- Chat does not invent unknown company/team/project details.

Bad:
- Repeated generic suggestions across batches.
- Hallucinated specifics not in transcript.
- Very long chat answers with low practical value.
