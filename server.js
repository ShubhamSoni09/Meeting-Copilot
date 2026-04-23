import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import Groq from "groq-sdk";
import multer from "multer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);
const upload = multer({ storage: multer.memoryStorage() });
const MIN_AUDIO_BYTES = 32;
const VALID_SUGGESTION_TYPES = new Set([
  "question",
  "talking-point",
  "answer",
  "fact-check",
  "clarification",
]);
const SUGGESTION_TYPE_MAPPING_GUIDANCE = [
  "Type mapping is strict:",
  "question = ask this out loud in the meeting.",
  "talking-point = statement the speaker can say in the meeting.",
  "clarification = ask meeting participants to clarify missing detail.",
  "fact-check = verify a claim against transcript context.",
  "answer = draft response the speaker can give in the meeting.",
].join(" ");

const cleanSentence = (value, maxLength) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  if (!text) {
    return "";
  }

  const lastChar = text[text.length - 1];
  if ([".", "!", "?"].includes(lastChar)) {
    return text;
  }
  return `${text}.`;
};

const normalizePreviewByType = (type, preview) => {
  const normalizedType = String(type || "").trim().toLowerCase();
  const text = String(preview || "").trim();
  if (!text) {
    return "";
  }

  if (["question", "clarification"].includes(normalizedType)) {
    const questionText = text.replace(/[.!]+$/, "").trim();
    return questionText.endsWith("?") ? questionText : `${questionText}?`;
  }

  if (normalizedType === "talking-point" || normalizedType === "answer") {
    const noQuestion = text.replace(/\?/g, ".").replace(/\s+/g, " ").trim();
    return cleanSentence(noQuestion, 160);
  }

  return cleanSentence(text, 160);
};

const tokenizeLower = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const getRareTokens = (text) => {
  return tokenizeLower(text).filter((token) => token.length >= 6);
};

const countUnknownRareTokens = (answer, transcriptContext, userMessage) => {
  const allowed = new Set([
    ...getRareTokens(transcriptContext),
    ...getRareTokens(userMessage),
    "unknown",
    "clarify",
    "cannot",
    "context",
    "transcript",
    "meeting",
    "speaker",
    "details",
  ]);

  const answerRareTokens = getRareTokens(answer);
  return answerRareTokens.filter((token) => !allowed.has(token)).length;
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "doing",
  "during",
  "focus",
  "from",
  "have",
  "into",
  "just",
  "like",
  "might",
  "should",
  "their",
  "there",
  "these",
  "those",
  "through",
  "under",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "would",
  "your",
]);

const getContentTokens = (text) =>
  tokenizeLower(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token));

const unsupportedContentTokenRatio = (answer, transcriptContext, userMessage) => {
  const allowed = new Set([
    ...getContentTokens(transcriptContext),
    ...getContentTokens(userMessage),
    "unknown",
    "transcript",
    "available",
    "current",
    "please",
    "share",
    "details",
    "could",
  ]);

  const answerTokens = getContentTokens(answer);
  if (answerTokens.length === 0) {
    return 0;
  }

  const unsupported = answerTokens.filter((token) => !allowed.has(token)).length;
  return unsupported / answerTokens.length;
};

const toPlainText = (text) => {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/\|/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const normalizeLoose = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasDuplicateSuggestionPreviews = (suggestions) => {
  const normalizedPreviews = suggestions.map((suggestion) =>
    normalizeLoose(suggestion.preview || ""),
  );
  return new Set(normalizedPreviews).size !== normalizedPreviews.length;
};

const tokenSet = (text) =>
  new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
  );

const jaccardSimilarity = (leftText, rightText) => {
  const left = tokenSet(leftText);
  const right = tokenSet(rightText);
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const hasNearDuplicateSuggestionPreviews = (suggestions, threshold = 0.72) => {
  for (let i = 0; i < suggestions.length; i += 1) {
    for (let j = i + 1; j < suggestions.length; j += 1) {
      const similarity = jaccardSimilarity(
        suggestions[i]?.preview || "",
        suggestions[j]?.preview || "",
      );
      if (similarity >= threshold) {
        return true;
      }
    }
  }
  return false;
};

const tooSimilarToRecentPreviews = (preview, recentPreviews, threshold = 0.68) => {
  const normalizedPreview = normalizeLoose(preview);
  const looksLikeTopFiveCriteriaIntent = (text) => {
    const normalized = normalizeLoose(text);
    const mentionsTopFive = /top\s*five|top\s*5/.test(normalized);
    const mentionsRanking = /criteria|rank|ranking|priorit|score/.test(normalized);
    const mentionsList = /20 30|20|30|list/.test(normalized);
    return mentionsTopFive && mentionsRanking && mentionsList;
  };

  return recentPreviews.some((recentPreview) => {
    const normalizedRecent = normalizeLoose(recentPreview);
    if (
      looksLikeTopFiveCriteriaIntent(normalizedPreview) &&
      looksLikeTopFiveCriteriaIntent(normalizedRecent)
    ) {
      return true;
    }
    return jaccardSimilarity(preview, recentPreview) >= threshold;
  });
};

const isLowSignalText = (text) => {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return true;
  }
  if (normalized.length < 25) {
    return true;
  }
  const tokens = tokenizeLower(normalized);
  const uniqueTokens = new Set(tokens);
  if (tokens.length < 8 || uniqueTokens.size < 5) {
    return true;
  }
  const meaninglessPatterns = [
    /\bblablabla\b/i,
    /\byada yada\b/i,
    /\bum+\b/i,
    /\buh+\b/i,
  ];
  if (meaninglessPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return false;
};

const buildLowSignalFallbackSuggestions = () => {
  return [
    {
      id: `${Date.now()}-0`,
      type: "clarification",
      preview:
        "Ask the speaker to restate the last point in one clear sentence before generating follow-up suggestions.",
      reason:
        "The recent transcript chunk is low-signal, so a concise restatement will improve suggestion quality.",
    },
    {
      id: `${Date.now()}-1`,
      type: "question",
      preview:
        "Confirm the immediate topic and decision goal for this section of the conversation.",
      reason:
        "Locking topic and intent now helps produce more useful and less generic live guidance.",
    },
    {
      id: `${Date.now()}-2`,
      type: "talking-point",
      preview:
        "Use a quick recap: what was said, what is unclear, and what concrete next question should be asked.",
      reason:
        "A short recap creates enough context to resume high-quality suggestions on the next refresh.",
    },
  ];
};

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const apiKey = req.body?.apiKey?.trim();

    if (!apiKey) {
      return res.status(400).json({ error: "Groq API key is required." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Audio blob is required." });
    }

    // MediaRecorder can emit tiny trailing blobs on stop/requestData.
    // Skip these to avoid Groq invalid media errors for non-audio payloads.
    if (req.file.size < MIN_AUDIO_BYTES) {
      return res.json({
        text: "",
        duration: 0,
        language: "unknown",
        createdAt: new Date().toISOString(),
        skipped: true,
      });
    }

    const groq = new Groq({ apiKey });
    const audioFile = new File([req.file.buffer], req.file.originalname || "audio.webm", {
      type: req.file.mimetype || "audio/webm",
    });

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-large-v3",
      response_format: "verbose_json",
      temperature: 0,
    });

    const rawText = String(transcription.text || "").trim();
    const duration = Number(transcription.duration || 0);

    if (!rawText) {
      return res.json({
        text: "",
        duration,
        language: transcription.language || "unknown",
        createdAt: new Date().toISOString(),
        skipped: true,
      });
    }

    return res.json({
      text: rawText,
      duration,
      language: transcription.language || "unknown",
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("could not process file - is it a valid media file?")) {
      return res.json({
        text: "",
        duration: 0,
        language: "unknown",
        createdAt: new Date().toISOString(),
        skipped: true,
      });
    }

    console.error("Transcription error:", error);
    return res.status(500).json({
      error: "Transcription failed.",
      details: message,
    });
  }
});

app.post("/api/suggestions", async (req, res) => {
  try {
    const apiKey = req.body.apiKey?.trim();
    const transcriptEntries = Array.isArray(req.body.transcriptEntries)
      ? req.body.transcriptEntries
      : [];
    const contextWindowSize = Number(req.body.contextWindowSize || 8);
    const customSystemPrompt = String(req.body.systemPrompt || "").trim();
    const customUserPrompt = String(req.body.userPrompt || "").trim();
    const previousSuggestions = Array.isArray(req.body.previousSuggestions)
      ? req.body.previousSuggestions
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const previousSuggestionTypes = Array.isArray(req.body.previousSuggestionTypes)
      ? req.body.previousSuggestionTypes
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 6)
      : [];

    if (!apiKey) {
      return res.status(400).json({ error: "Groq API key is required." });
    }

    if (transcriptEntries.length === 0) {
      return res.status(400).json({ error: "Transcript context is required." });
    }

    const latestEntries = transcriptEntries.slice(-Math.max(1, contextWindowSize));
    const lowSignalEntryCount = latestEntries.filter((entry) =>
      isLowSignalText(entry.text),
    ).length;
    const lowSignalRatio =
      latestEntries.length > 0 ? lowSignalEntryCount / latestEntries.length : 0;
    const lowSignalRecentContext = lowSignalRatio >= 0.6;

    if (lowSignalRecentContext) {
      return res.json({
        createdAt: new Date().toISOString(),
        suggestions: buildLowSignalFallbackSuggestions(),
      });
    }

    const contextText = latestEntries
      .map((entry, index) => {
        const timestamp = entry.createdAt
          ? new Date(entry.createdAt).toLocaleTimeString()
          : "unknown-time";
        return `${index + 1}. [${timestamp}] ${entry.text}`;
      })
      .join("\n");
    const recentSuggestionText =
      previousSuggestions.length > 0
        ? previousSuggestions.map((preview, index) => `${index + 1}. ${preview}`).join("\n")
        : "(none)";

    const groq = new Groq({ apiKey });
    const requestSuggestions = async (strictMode = false) => {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        temperature: strictMode ? 0.2 : 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              customSystemPrompt ||
              [
                "You generate live meeting assistant suggestions while a conversation is happening.",
                "Return exactly 3 concise, high-value suggestions in strict JSON format.",
                "Each preview must be useful even if the user never clicks.",
                "Use diverse suggestion types when context supports it: question, talking-point, answer, fact-check, clarification.",
                "At least 2 different types should appear in most batches.",
                SUGGESTION_TYPE_MAPPING_GUIDANCE,
                "Ground every claim in transcript context only. Do not invent names, companies, roles, teams, tools, products, timelines, or numbers.",
                "Prioritize what is most timely in the newest transcript lines.",
                "Avoid near-duplicate suggestions from recent batches unless context has clearly changed.",
                strictMode
                  ? "STRICT MODE: ensure all 3 suggestions are distinct, concrete, and non-generic."
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
          },
          {
            role: "user",
            content:
              customUserPrompt ||
              [
                "Read this recent transcript context and return JSON in this shape:",
                '{ "suggestions": [ { "type": "question|talking-point|answer|fact-check|clarification", "preview": "short actionable suggestion (<= 160 chars)", "reason": "1 sentence why this is timely" } ] }',
                "Return exactly 3 suggestions in the array.",
                "Each preview should be concrete and specific, not generic.",
                "Both preview and reason must be complete sentences, not fragments.",
                "Respect this type behavior: question/clarification previews must be direct questions to meeting participants; talking-point/answer previews must be meeting-ready statements (not questions).",
                "If context is sparse, prioritize clarification/question suggestions over speculation.",
                "Recent transcript:",
                contextText,
                "Recent suggestion previews to avoid repeating:",
                recentSuggestionText,
              ].join("\n\n"),
          },
        ],
      });
      const rawContent = completion.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(rawContent);
      return {
        rawContent,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    };

    let result = await requestSuggestions(false);
    const needsRetry = (candidateSuggestions) => {
      if (candidateSuggestions.length !== 3) {
        return true;
      }
      if (
        hasDuplicateSuggestionPreviews(candidateSuggestions) ||
        hasNearDuplicateSuggestionPreviews(candidateSuggestions)
      ) {
        return true;
      }
      const tooSimilarCount = candidateSuggestions.filter((candidate) =>
        tooSimilarToRecentPreviews(candidate.preview, previousSuggestions, 0.58),
      ).length;
      return tooSimilarCount >= 2;
    };

    if (needsRetry(result.suggestions)) {
      result = await requestSuggestions(true);
      if (needsRetry(result.suggestions)) {
        result = await requestSuggestions(true);
      }
    }
    const suggestions = result.suggestions;

    if (suggestions.length !== 3) {
      return res.status(502).json({
        error: "Model did not return exactly 3 suggestions.",
        raw: result.rawContent,
      });
    }

    const normalized = suggestions.map((suggestion, index) => {
      const normalizedType = String(suggestion.type || "").trim().toLowerCase();
      return {
        id: `${Date.now()}-${index}`,
        type: VALID_SUGGESTION_TYPES.has(normalizedType)
          ? normalizedType
          : "clarification",
        preview: (() => {
          const suggestedType = VALID_SUGGESTION_TYPES.has(normalizedType)
            ? normalizedType
            : "clarification";
          return (
            normalizePreviewByType(suggestedType, suggestion.preview) ||
            "Can you clarify the latest unresolved point so we can proceed?"
          );
        })(),
        reason:
          cleanSentence(suggestion.reason, 220) ||
          "This is timely based on the most recent transcript context.",
      };
    });

    // Final local novelty guard against prior batches.
    for (let i = 0; i < normalized.length; i += 1) {
      if (tooSimilarToRecentPreviews(normalized[i].preview, previousSuggestions)) {
        normalized[i] = {
          ...normalized[i],
          type: "clarification",
          preview:
            "Ask one concrete follow-up that clarifies the latest unresolved point before proposing broader actions.",
          reason:
            "This avoids repeating earlier suggestions and targets the newest unresolved context.",
        };
      }
    }

    const uniqueTypeCount = new Set(normalized.map((suggestion) => suggestion.type)).size;
    if (uniqueTypeCount < 2 && normalized.length === 3) {
      const fallbackTypeOrder = ["question", "talking-point", "fact-check", "clarification"];
      const currentType = normalized[0].type;
      const fallbackType = fallbackTypeOrder.find((type) => type !== currentType) || "clarification";
      normalized[2] = {
        ...normalized[2],
        type: fallbackType,
      };
    }

    // If previous batch leaned too heavily on clarification, force stronger actionability.
    const previousClarificationCount = previousSuggestionTypes.filter(
      (type) => type === "clarification",
    ).length;
    const hasActionableAnchor = normalized.some((item) =>
      ["answer", "talking-point"].includes(item.type),
    );
    if (previousClarificationCount >= 2 && !hasActionableAnchor && normalized.length > 0) {
      normalized[normalized.length - 1] = {
        ...normalized[normalized.length - 1],
        type: "talking-point",
        preview:
          "Propose one concrete decision statement the team can align on before moving to the next topic.",
        reason:
          "The prior batch was clarification-heavy; this keeps the meeting moving with an actionable anchor.",
      };
    }

    return res.json({
      createdAt: new Date().toISOString(),
      suggestions: normalized,
    });
  } catch (error) {
    console.error("Suggestions error:", error);
    const status = Number(error?.status || 0);
    const details = error instanceof Error ? error.message : "Unknown error";
    const isRateLimited =
      status === 429 || /rate limit|rate_limit_exceeded|tokens per day/i.test(details);

    if (isRateLimited) {
      return res.status(429).json({
        error:
          "Suggestions are temporarily rate-limited on the current Groq key. Please wait and retry, or use a key with higher quota.",
        details,
      });
    }

    return res.status(500).json({
      error: "Suggestions request failed.",
      details,
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = req.body.apiKey?.trim();
    const transcriptEntries = Array.isArray(req.body.transcriptEntries)
      ? req.body.transcriptEntries
      : [];
    const chatHistory = Array.isArray(req.body.chatHistory) ? req.body.chatHistory : [];
    const userMessage = String(req.body.userMessage || "").trim();
    const interactionSource = String(req.body.interactionSource || "").trim().toLowerCase();
    const interactionTag = String(req.body.interactionTag || "").trim().toLowerCase();
    const contextWindowSize = Number(req.body.contextWindowSize || 12);
    const customSystemPrompt = String(req.body.systemPrompt || "").trim();

    if (!apiKey) {
      return res.status(400).json({ error: "Groq API key is required." });
    }
    if (!userMessage) {
      return res.status(400).json({ error: "Chat message is required." });
    }

    const latestEntries = transcriptEntries.slice(-Math.max(1, contextWindowSize));
    const transcriptContext = latestEntries
      .map((entry, index) => {
        const timestamp = entry.createdAt
          ? new Date(entry.createdAt).toLocaleTimeString()
          : "unknown-time";
        return `${index + 1}. [${timestamp}] ${entry.text}`;
      })
      .join("\n");

    const recentHistory = chatHistory
      .slice(-10)
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || "").trim(),
      }))
      .filter((message) => message.content.length > 0);

    const getTagSpecificGuidance = () => {
      if (interactionSource !== "suggestion") {
        return "";
      }
      if (interactionTag.includes("question")) {
        return [
          "TAG MODE: Question to ask.",
          "Output a meeting-ready question the speaker should ask other meeting members out loud.",
          "The primary actionable line must be a single explicit question ending with '?'.",
          "Do not ask the user to clarify something for the assistant.",
        ].join(" ");
      }
      if (interactionTag.includes("fact-check")) {
        return [
          "TAG MODE: Fact-check.",
          "State what claim should be verified against transcript evidence now.",
          "Include one concrete verification question the speaker can ask meeting participants.",
        ].join(" ");
      }
      if (interactionTag.includes("talking point")) {
        return [
          "TAG MODE: Talking point.",
          "Provide one strong meeting-ready statement the speaker can say now, with at most one backup line.",
        ].join(" ");
      }
      if (interactionTag.includes("clarification")) {
        return [
          "TAG MODE: Clarification.",
          "Identify the ambiguity and provide one precise clarification question to ask meeting participants immediately.",
        ].join(" ");
      }
      if (interactionTag.includes("answer")) {
        return [
          "TAG MODE: Answer.",
          "Provide a direct draft response the speaker can give in the meeting, then one practical next step.",
        ].join(" ");
      }
      return "";
    };
    const tagSpecificGuidance = getTagSpecificGuidance();
    const suggestionModeGuidance =
      interactionSource === "suggestion"
        ? "For suggestion clicks, write meeting-ready lines for what the speaker should say or ask to meeting members. Do not ask the user to clarify things for the assistant."
        : "";

    const groq = new Groq({ apiKey });
    const makeChatCompletion = async (strictMode = false) => {
      return groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              customSystemPrompt ||
              [
                "You are TwinMind's meeting copilot.",
                "Ground every factual claim in transcript context only.",
                "Do not invent names, companies, job titles, tools, products, or numbers.",
                "Do not infer unstated responsibilities or project details.",
                "If a requested detail is missing, say 'Not available in current transcript' once and ask one concise follow-up.",
                "When context is missing, keep the response short and avoid generic filler.",
                "Ask for one specific missing detail needed to answer precisely.",
                SUGGESTION_TYPE_MAPPING_GUIDANCE,
                suggestionModeGuidance,
                tagSpecificGuidance,
                "Keep responses concise and useful for a live meeting with practical next-step guidance.",
                "Use plain text only. Do not use markdown, bold markers, headings, tables, or code blocks.",
                "Prefer short paragraphs by default. Use bullets only when the user explicitly asks for a list.",
                strictMode
                  ? "STRICT MODE: Regenerate with maximum caution. Avoid any entity not seen in transcript or user message."
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
          },
          {
            role: "user",
            content: [
              "Transcript context:",
              transcriptContext || "No transcript captured yet.",
              "",
              interactionSource === "suggestion"
                ? "Respond as meeting-ready wording the speaker can say to participants (or ask participants), based on the clicked suggestion type."
                : "Answer the next request as a helpful assistant.",
            ].join("\n"),
          },
          ...recentHistory,
          { role: "user", content: userMessage },
        ],
      });
    };

    let completion = await makeChatCompletion(false);
    let answer = String(completion.choices[0]?.message?.content || "").trim();

    const suspiciousTokenCount = countUnknownRareTokens(
      answer,
      transcriptContext,
      userMessage,
    );

    if (suspiciousTokenCount >= 4) {
      completion = await makeChatCompletion(true);
      answer = String(completion.choices[0]?.message?.content || "").trim();
    }

    const unsupportedRatio = unsupportedContentTokenRatio(
      answer,
      transcriptContext,
      userMessage,
    );
    if (unsupportedRatio > 0.7) {
      completion = await makeChatCompletion(true);
      answer = String(completion.choices[0]?.message?.content || "").trim();
    }

    answer = toPlainText(answer)
      .replace(/Unknown from transcript/gi, "Not available in current transcript")
      .trim();

    const finalUnsupportedRatio = unsupportedContentTokenRatio(
      answer,
      transcriptContext,
      userMessage,
    );
    const buildSuggestionTagFallback = () => {
      if (interactionTag.includes("question")) {
        return 'Question to ask: "Can we confirm the exact decision we need to make right now?"';
      }
      if (interactionTag.includes("clarification")) {
        return 'Clarification to ask: "Can you clarify the specific detail that is still unclear so we can proceed?"';
      }
      if (interactionTag.includes("fact-check")) {
        return [
          "Fact-check target: The exact claim is not fully supported by the current transcript.",
          'Verification question to ask: "Can we confirm this claim with the exact wording or data point from our discussion?"',
        ].join("\n");
      }
      if (interactionTag.includes("talking point")) {
        return "Talking point: Based on current transcript, we should align on one clear owner, deadline, and next action before moving on.";
      }
      if (interactionTag.includes("answer")) {
        return [
          "Draft response: Based on current transcript, the exact detail is not available yet.",
          "Next step: Ask the group for the missing specific fact, then restate the answer clearly.",
        ].join("\n");
      }
      return "Not available in current transcript. Please share one specific detail and I will answer precisely.";
    };
    if (finalUnsupportedRatio > 0.78 && finalUnsupportedRatio <= 0.93) {
      const latestLine = String(latestEntries[latestEntries.length - 1]?.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      if (interactionSource === "suggestion") {
        answer = [
          `Based on current transcript, best current read is: ${
            latestLine || "the team is still clarifying details."
          }`,
          buildSuggestionTagFallback(),
        ].join("\n\n");
      } else {
        answer = [
          `Based on current transcript, best current read is: ${
            latestLine || "the team is still clarifying details."
          }`,
          "Missing detail: Not available in current transcript. Could you clarify the exact decision or metric you want to lock right now?",
        ].join("\n\n");
      }
    }

    if (finalUnsupportedRatio > 0.93) {
      answer =
        interactionSource === "suggestion"
          ? buildSuggestionTagFallback()
          : "Not available in current transcript. Please share one specific detail and I will answer precisely.";
    }

    if (!answer) {
      return res.status(502).json({ error: "Model returned an empty chat response." });
    }

    if (interactionSource === "suggestion" && interactionTag.includes("question")) {
      const hasQuestionMark = /\?/.test(answer);
      if (!hasQuestionMark) {
        answer = `${answer}\n\nNext question to ask: "Can you clarify the exact point we need to decide right now?"`;
      }
    }
    if (interactionSource === "suggestion" && interactionTag.includes("clarification")) {
      const hasQuestionMark = /\?/.test(answer);
      if (!hasQuestionMark) {
        answer = `${answer}\n\nClarification question to ask: "Can you clarify the exact missing detail we need before deciding?"`;
      }
    }

    return res.json({
      answer,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Chat error:", error);
    const status = Number(error?.status || 0);
    const details = error instanceof Error ? error.message : "Unknown error";
    const isRateLimited =
      status === 429 || /rate limit|rate_limit_exceeded|tokens per day/i.test(details);

    if (isRateLimited) {
      return res.status(429).json({
        error:
          "Chat is temporarily rate-limited on the current Groq key. Please wait and retry, or use a key with higher quota.",
        details,
      });
    }

    return res.status(500).json({
      error: "Chat request failed.",
      details,
    });
  }
});

app.use((error, _req, res, next) => {
  if (!error) {
    return next();
  }

  const message = String(error.message || "");
  if (message.includes("Multipart: Boundary not found")) {
    return res.status(400).json({
      error: "Malformed multipart request. Audio payload boundary is missing.",
    });
  }

  return res.status(500).json({
    error: "Unexpected server error.",
    details: message || "Unknown error",
  });
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
