import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type TranscriptEntry = {
  id: string;
  text: string;
  createdAt: string;
  durationSeconds: number;
  /** Wall time captured for this slice (browser clock); closer to the nominal chunk window than STT `durationSeconds`. */
  wallSliceSeconds?: number | null;
};

type QueuedAudioChunk = {
  blob: Blob;
  wallSliceSeconds: number | null;
};

type TranscriptionResponse = {
  text: string;
  duration: number;
  language: string;
  createdAt: string;
  skipped?: boolean;
  error?: string;
  details?: string;
};

type Suggestion = {
  id: string;
  type: string;
  preview: string;
  reason: string;
};

type SuggestionBatch = {
  id: string;
  createdAt: string;
  suggestions: Suggestion[];
};

type SuggestionsResponse = {
  createdAt: string;
  suggestions: Suggestion[];
  error?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  source: "typed" | "suggestion" | "assistant";
  userTag?: string;
};

type ChatResponse = {
  answer: string;
  createdAt: string;
  error?: string;
};

type AppSettings = {
  suggestionContextWindow: number;
  chatContextWindow: number;
  detailedAnswerContextWindow: number;
  liveSuggestionSystemPrompt: string;
  liveSuggestionUserPromptTemplate: string;
  detailedAnswerSystemPrompt: string;
  chatSystemPrompt: string;
};

const CHUNK_DURATION_MS = 30_000;
const MIN_CLIENT_CHUNK_BYTES = 32;

function createMediaRecorderForStream(stream: MediaStream): MediaRecorder {
  const preferredMimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  const selectedMimeType = preferredMimeTypes.find((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
  );
  return selectedMimeType
    ? new MediaRecorder(stream, { mimeType: selectedMimeType })
    : new MediaRecorder(stream);
}
const DEFAULT_SETTINGS: AppSettings = {
  suggestionContextWindow: 8,
  chatContextWindow: 12,
  detailedAnswerContextWindow: 16,
  liveSuggestionSystemPrompt: [
    "You generate live meeting assistant suggestions while a conversation is happening.",
    "Return exactly 3 concise, high-value suggestions in strict JSON format.",
    "Each suggestion preview must be immediately useful even if not clicked.",
    "Prioritize recency: optimize for the newest 1-2 transcript lines first, use older lines only for consistency.",
    "Prioritize diversity across suggestion types when context supports it: question, talking-point, answer, fact-check, clarification.",
    "At least 2 different types should appear in most batches.",
    "Avoid repeating the same intent as recent suggestions unless context has materially changed.",
    "If transcript signal is weak (filler, very short, or unclear), switch to clarification-first suggestions.",
    "Ground everything in transcript facts only; do not invent names, companies, teams, roles, tools, products, timelines, or numbers.",
    "Keep wording concrete and action-first; avoid generic strategy language.",
  ].join(" "),
  liveSuggestionUserPromptTemplate: [
    "Read this recent transcript context and return JSON in this shape:",
    '{ "suggestions": [ { "type": "question|talking-point|answer|fact-check|clarification", "preview": "short actionable suggestion (<= 160 chars)", "reason": "1 sentence why this is timely" } ] }',
    "Return exactly 3 suggestions in the array.",
    "Each preview should be concrete and specific, not generic.",
    "Keep each preview <= 120 chars when possible.",
    "Both preview and reason must be complete sentences, not fragments.",
    "If context is sparse, prefer clarification/question suggestions over speculation.",
    "Do not repeat suggestions that are semantically similar to recent suggestion previews.",
    "Recent transcript:",
    "{{context}}",
    "Recent suggestion previews to avoid repeating (if provided):",
    "{{recent_suggestions}}",
  ].join("\n\n"),
  detailedAnswerSystemPrompt: [
    "You are TwinMind's meeting copilot answering a clicked live suggestion.",
    "Ground every factual claim in transcript context only.",
    "Do not invent names, companies, job titles, architecture details, tools, products, ownership, or numbers.",
    "Keep the answer brief and live-meeting friendly (typically 60-120 words).",
    "Structure the response in this order: 1) direct answer, 2) why this matters now, 3) next step the speaker can take in this meeting.",
    "Use one primary recommendation and at most one backup option.",
    "Avoid generic business jargon (for example 'stakeholder confidence', 'growth narrative', 'strategic alignment') unless explicitly spoken in transcript.",
    "Reuse transcript wording when possible (for example terms like 'vulnerability management', 'Browser beta DAST', or specific concerns already raised).",
    "If information is missing, keep the response short: say 'Not available in current transcript' once, then ask one targeted follow-up question in one sentence.",
    "When information is missing, skip broad 'why this matters' filler and focus on the exact missing detail needed.",
    "Use plain text only. Do not use markdown symbols, headings, tables, or code blocks.",
  ].join(" "),
  chatSystemPrompt: [
    "You are TwinMind's meeting copilot.",
    "Ground every factual claim in transcript context only.",
    "Do not invent names, companies, job titles, tools, products, or numbers.",
    "If a requested detail is missing, say 'Not available in current transcript' once and ask one concise follow-up.",
    "When context is missing, keep the answer <= 45 words and avoid repeating generic justifications.",
    "Do not repeat the same fallback wording across turns; vary the targeted follow-up based on the latest user question.",
    "Keep responses concise and useful for a live meeting with clear next-step guidance.",
    "Use plain text only. Do not use markdown, bold markers, headings, tables, or code blocks.",
    "Prefer short paragraphs by default. Use bullets only if the user asks.",
  ].join(" "),
};

const parseApiResponse = async <T,>(response: Response): Promise<T> => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  const rawText = await response.text();
  throw new Error(
    rawText.startsWith("<!DOCTYPE")
      ? "Server returned HTML instead of JSON. Please refresh the page and retry."
      : rawText || "Server returned an unexpected response.",
  );
};

const formatSuggestionTypeLabel = (type: string) => {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "fact-check") {
    return "Fact-check";
  }
  if (normalized === "talking-point") {
    return "Talking point";
  }
  if (normalized === "clarification") {
    return "Clarification";
  }
  if (normalized === "question") {
    return "Question to ask";
  }
  if (normalized === "answer") {
    return "Answer";
  }
  return "Suggestion";
};

const CHAT_SECTION_TITLES = [
  "Direct answer",
  "Why this matters now",
  "Next step you can take in this meeting",
  "Next step",
];

const toUiErrorMessage = (scope: "Chat" | "Suggestions", rawMessage: string) => {
  const normalized = String(rawMessage || "").toLowerCase();
  if (
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit_exceeded") ||
    normalized.includes("tokens per day") ||
    normalized.includes("429")
  ) {
    return `${scope} is temporarily rate-limited. Please retry in a few minutes.`;
  }
  if (rawMessage.length > 180) {
    return `${scope} request failed. Please retry.`;
  }
  return `Error: ${rawMessage}`;
};

function App() {
  const [apiKey, setApiKey] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraftEdited, setSettingsDraftEdited] = useState(false);
  const [settingsSavedNotice, setSettingsSavedNotice] = useState<string | null>(null);
  const [settingsDiscardConfirmOpen, setSettingsDiscardConfirmOpen] = useState(false);
  const [lastSuggestionLatencyMs, setLastSuggestionLatencyMs] = useState<number | null>(null);
  const [lastChatLatencyMs, setLastChatLatencyMs] = useState<number | null>(null);
  const [clearSessionConfirmOpen, setClearSessionConfirmOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** `segment-rotate`: stop only the recorder, keep the mic stream and start a new recorder (manual transcript flush). */
  const stopIntentRef = useRef<"full" | "segment-rotate" | null>(null);
  const stopRecordingInProgressRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptionQueueRef = useRef<QueuedAudioChunk[]>([]);
  const chunkIntervalRef = useRef<number | null>(null);
  /** When the current MediaRecorder segment began (for wall-clock slice length in UI). */
  const segmentWallClockStartRef = useRef<number | null>(null);
  const isProcessingQueueRef = useRef(false);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const clearScheduledTranscriptionFlush = () => {
    if (chunkIntervalRef.current != null) {
      window.clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }
  };

  const markSegmentWallClockStart = () => {
    segmentWallClockStartRef.current = Date.now();
  };

  /** Same cadence as manual "Refresh Transcript": stop + new recorder (reliable WebM); timeslice-only mode often misses later slices in Chromium. */
  const scheduleTranscriptionFlush = () => {
    clearScheduledTranscriptionFlush();
    chunkIntervalRef.current = window.setInterval(() => {
      if (stopRecordingInProgressRef.current) {
        return;
      }
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== "recording") {
        return;
      }
      stopIntentRef.current = "segment-rotate";
      try {
        recorder.stop();
      } catch {
        // Ignore stop races (e.g. recorder already rotating).
      }
    }, CHUNK_DURATION_MS);
  };

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages]);

  const pushTranscriptEntry = (entry: TranscriptEntry) => {
    setTranscript((previous) => [...previous, entry]);
  };

  const generateSuggestions = async (entries: TranscriptEntry[]) => {
    if (!apiKey.trim()) {
      return;
    }
    if (entries.length === 0) {
      return;
    }

    const recentSuggestionPreviews = suggestionBatches
      .slice(0, 3)
      .flatMap((batch) => batch.suggestions.map((suggestion) => suggestion.preview))
      .slice(0, 9);

    setIsGeneratingSuggestions(true);
    const startedAt = performance.now();
    try {
      const response = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          contextWindowSize: settings.suggestionContextWindow,
          systemPrompt: settings.liveSuggestionSystemPrompt,
          userPrompt: settings.liveSuggestionUserPromptTemplate.replace(
            "{{context}}",
            entries
              .slice(-Math.max(1, settings.suggestionContextWindow))
              .map((entry, index) => `${index + 1}. [${entry.createdAt}] ${entry.text}`)
              .join("\n"),
          ).replace(
            "{{recent_suggestions}}",
            recentSuggestionPreviews.length > 0
              ? recentSuggestionPreviews.map((preview, index) => `${index + 1}. ${preview}`).join("\n")
              : "(none)",
          ),
          transcriptEntries: entries.map((entry) => ({
            text: entry.text,
            createdAt: entry.createdAt,
          })),
          previousSuggestions: recentSuggestionPreviews,
          previousSuggestionTypes:
            suggestionBatches[0]?.suggestions.map((suggestion) => suggestion.type) || [],
        }),
      });

      const data = await parseApiResponse<SuggestionsResponse>(response);
      if (!response.ok) {
        throw new Error(
          [data.error, (data as { details?: string }).details]
            .filter(Boolean)
            .join(": ") || "Suggestions request failed.",
        );
      }

      if (data.suggestions.length !== 3) {
        throw new Error("Suggestions endpoint must return exactly 3 items.");
      }

      setSuggestionBatches((previous) => [
        {
          id: crypto.randomUUID(),
          createdAt: data.createdAt || new Date().toISOString(),
          suggestions: data.suggestions,
        },
        ...previous,
      ]);
      setLastSuggestionLatencyMs(Math.round(performance.now() - startedAt));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown suggestions error.";
      setStatusMessage(toUiErrorMessage("Suggestions", message));
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  const processTranscriptionQueue = async () => {
    if (isProcessingQueueRef.current) {
      return;
    }

    isProcessingQueueRef.current = true;
    setIsTranscribing(true);

    try {
      while (transcriptionQueueRef.current.length > 0) {
        const nextChunk = transcriptionQueueRef.current.shift();
        if (!nextChunk) {
          continue;
        }

        try {
          const formData = new FormData();
          formData.append("audio", nextChunk.blob, `chunk-${Date.now()}.webm`);
          formData.append("apiKey", apiKey.trim());

          setStatusMessage("Transcribing latest chunk...");

          const response = await fetch("/api/transcribe", {
            method: "POST",
            body: formData,
          });

          const data = await parseApiResponse<TranscriptionResponse>(response);

          if (!response.ok) {
            throw new Error(
              [data.error, data.details].filter(Boolean).join(": ") ||
                "Transcription request failed.",
            );
          }

          const transcriptText = (data.text ?? "").trim();
          if (data.skipped || !transcriptText) {
            setStatusMessage(
              isRecording
                ? "Recording... (that audio slice had nothing to transcribe — try again after more speech)"
                : "Idle",
            );
            continue;
          }

          const newEntry = {
            id: crypto.randomUUID(),
            text: transcriptText,
            durationSeconds: Number(data.duration || 0),
            createdAt: data.createdAt || new Date().toISOString(),
            wallSliceSeconds: nextChunk.wallSliceSeconds,
          };
          pushTranscriptEntry(newEntry);
          const nextTranscript = [...transcriptRef.current, newEntry].sort(
            (first, second) =>
              new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
          );
          await generateSuggestions(nextTranscript);
        } catch (chunkError) {
          const message =
            chunkError instanceof Error ? chunkError.message : "Unknown transcription error.";
          setStatusMessage(`Error: ${message}`);
        }
      }

      setStatusMessage(isRecording ? "Recording..." : "Idle");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown transcription error.";
      setStatusMessage(`Error: ${message}`);
    } finally {
      setIsTranscribing(false);
      isProcessingQueueRef.current = false;
      if (transcriptionQueueRef.current.length > 0) {
        queueMicrotask(() => {
          void processTranscriptionQueue();
        });
      }
    }
  };

  const enqueueAudioChunk = (blob: Blob, wallSliceSeconds: number | null) => {
    if (blob.size < MIN_CLIENT_CHUNK_BYTES) {
      return;
    }
    transcriptionQueueRef.current.push({ blob, wallSliceSeconds });
    void processTranscriptionQueue();
  };

  const stopRecording = async () => {
    stopRecordingInProgressRef.current = true;
    clearScheduledTranscriptionFlush();
    stopIntentRef.current = "full";
    try {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        setStatusMessage("Stopping... finalizing last chunk.");
        // Do not call requestData() before stop(): with segment-based recording it can flush
        // the buffer so stop() only emits a tiny tail that is skipped, losing the final slice.
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            window.clearTimeout(fallbackTimer);
            recorder.removeEventListener("stop", onRecorderStop);
            resolve();
          };
          const onRecorderStop = () => finish();
          const fallbackTimer = window.setTimeout(finish, 2500);
          recorder.addEventListener("stop", onRecorderStop);
          try {
            recorder.stop();
          } catch {
            finish();
          }
        });
      }
    } finally {
      stopRecordingInProgressRef.current = false;
    }
    setIsRecording(false);
    queueMicrotask(() => {
      void processTranscriptionQueue();
    });
  };

  function wireRecorderHandlers(recorder: MediaRecorder, stream: MediaStream) {
    recorder.ondataavailable = (event: BlobEvent) => {
      const wallSliceSeconds =
        segmentWallClockStartRef.current != null
          ? (Date.now() - segmentWallClockStartRef.current) / 1000
          : null;
      enqueueAudioChunk(event.data, wallSliceSeconds);
    };

    recorder.onerror = () => {
      setStatusMessage("Microphone recorder failed.");
      void stopRecording();
    };

    recorder.onstop = () => {
      const intent = stopIntentRef.current;
      if (intent === "segment-rotate") {
        stopIntentRef.current = null;
        const activeStream = streamRef.current;
        if (!activeStream?.active) {
          setStatusMessage("Mic stream ended; could not continue recording.");
          setIsRecording(false);
          mediaRecorderRef.current = null;
          clearScheduledTranscriptionFlush();
          segmentWallClockStartRef.current = null;
          return;
        }
        try {
          const nextRecorder = createMediaRecorderForStream(activeStream);
          wireRecorderHandlers(nextRecorder, activeStream);
          mediaRecorderRef.current = nextRecorder;
          nextRecorder.start();
          markSegmentWallClockStart();
          scheduleTranscriptionFlush();
          setStatusMessage("Recording...");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Recorder restart failed.";
          setStatusMessage(`Error: ${message}`);
          setIsRecording(false);
          mediaRecorderRef.current = null;
          activeStream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          clearScheduledTranscriptionFlush();
          segmentWallClockStartRef.current = null;
        }
        return;
      }

      stopIntentRef.current = null;
      clearScheduledTranscriptionFlush();
      stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      streamRef.current = null;
      segmentWallClockStartRef.current = null;
      void processTranscriptionQueue();
      setStatusMessage("Stopped");
    };
  }

  const startRecording = async () => {
    if (!apiKey.trim()) {
      setStatusMessage("Paste your Groq API key before recording.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      stopIntentRef.current = null;
      const recorder = createMediaRecorderForStream(stream);

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      wireRecorderHandlers(recorder, stream);

      // Accumulate until interval-driven or manual segment stop (same path as "Refresh Transcript").
      // Chromium often fails to emit usable later blobs with timeslice-only mode.
      recorder.start();
      markSegmentWallClockStart();
      scheduleTranscriptionFlush();
      setIsRecording(true);
      setStatusMessage("Recording...");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mic access denied.";
      setStatusMessage(`Cannot start recording: ${message}`);
      setIsRecording(false);
    }
  };

  const manualRefresh = () => {
    if (!isRecording || !mediaRecorderRef.current) {
      setStatusMessage("Start recording to refresh transcript.");
      return;
    }
    if (stopRecordingInProgressRef.current) {
      setStatusMessage("Wait for the mic to finish stopping.");
      return;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder.state !== "recording") {
      setStatusMessage("Recorder is not active.");
      return;
    }

    // requestData() between timeslice ticks often yields muxer fragments Whisper skips.
    // Stopping this recorder emits one self-contained blob; onstop starts a new recorder
    // on the same mic stream so recording continues.
    stopIntentRef.current = "segment-rotate";
    setStatusMessage("Refreshing transcript...");
    try {
      recorder.stop();
    } catch (error) {
      stopIntentRef.current = null;
      setStatusMessage(
        error instanceof Error ? error.message : "Could not refresh current recording chunk.",
      );
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      void stopRecording();
      return;
    }
    void startRecording();
  };

  const reloadSuggestions = async () => {
    if (!apiKey.trim()) {
      setStatusMessage("Paste your Groq API key before reloading suggestions.");
      return;
    }
    if (sortedTranscript.length === 0) {
      setStatusMessage("Transcript is empty. Record audio first.");
      return;
    }
    setStatusMessage("Reloading suggestions...");
    await generateSuggestions(sortedTranscript);
    setStatusMessage(isRecording ? "Recording..." : "Idle");
  };

  const runChatTurn = useCallback(
    async (messageText: string, source: "typed" | "suggestion", userTag?: string) => {
      const trimmed = messageText.trim();
      if (!trimmed) {
        return;
      }
      if (!apiKey.trim()) {
        setStatusMessage("Paste your Groq API key before using chat.");
        return;
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
        source,
        userTag,
      };

      const nextHistory = [...chatMessages, userMessage];
      setChatMessages(nextHistory);
      setIsChatLoading(true);
      if (source === "typed") {
        setChatInput("");
      }

      try {
        const startedAt = performance.now();
        // Mapping guard:
        // - clicked suggestion => detailedAnswerSystemPrompt
        // - typed chat => chatSystemPrompt
        const selectedContextWindowSize =
          source === "suggestion"
            ? settings.detailedAnswerContextWindow
            : settings.chatContextWindow;
        const selectedSystemPrompt =
          source === "suggestion"
            ? settings.detailedAnswerSystemPrompt
            : settings.chatSystemPrompt;

        const payload = {
          apiKey: apiKey.trim(),
          userMessage: trimmed,
          interactionSource: source,
          interactionTag: userTag || "",
          contextWindowSize: selectedContextWindowSize,
          systemPrompt: selectedSystemPrompt,
          transcriptEntries: transcriptRef.current.map((entry) => ({
            text: entry.text,
            createdAt: entry.createdAt,
          })),
          chatHistory: nextHistory.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          })),
        };

        let response: Response | null = null;
        let data: ChatResponse | null = null;
        let lastError: unknown = null;

        // Retry once for transient failures (5xx/network/429).
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            data = await parseApiResponse<ChatResponse>(response);
            if (response.ok) {
              break;
            }
            const retryable = response.status >= 500 || response.status === 429;
            if (!retryable || attempt === 1) {
              throw new Error(
                [data.error, data.details].filter(Boolean).join(": ") || "Chat request failed.",
              );
            }
            await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
          } catch (error) {
            lastError = error;
            if (attempt === 1) {
              throw error;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
          }
        }

        if (!response || !data || !response.ok) {
          const message =
            lastError instanceof Error
              ? lastError.message
              : [data?.error, data?.details].filter(Boolean).join(": ") ||
                "Chat request failed.";
          throw new Error(message);
        }

        setChatMessages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.answer,
            createdAt: data.createdAt || new Date().toISOString(),
            source: "assistant",
          },
        ]);
        setLastChatLatencyMs(Math.round(performance.now() - startedAt));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown chat error.";
        setStatusMessage(toUiErrorMessage("Chat", message));
      } finally {
        setIsChatLoading(false);
      }
    },
    [apiKey, chatMessages, settings],
  );

  const onSubmitChat = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runChatTurn(chatInput, "typed", "Question");
  };

  const exportSession = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      performance: {
        lastSuggestionLatencyMs,
        lastChatLatencyMs,
      },
      transcript: [...transcript].sort(
        (first, second) =>
          new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
      ),
      suggestionBatches,
      chatHistory: chatMessages,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `twinmind-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearSession = useCallback(() => {
    transcriptionQueueRef.current = [];
    setTranscript([]);
    setSuggestionBatches([]);
    setChatMessages([]);
    setChatInput("");
    setLastSuggestionLatencyMs(null);
    setLastChatLatencyMs(null);
    setStatusMessage(isRecording ? "Recording..." : "Idle");
  }, [isRecording]);

  const openClearSessionConfirm = useCallback(() => {
    if (isRecording) {
      setStatusMessage("Stop the mic before clearing session.");
      return;
    }
    setClearSessionConfirmOpen(true);
  }, [isRecording]);

  const closeClearSessionConfirm = useCallback(() => {
    setClearSessionConfirmOpen(false);
  }, []);

  const confirmClearSession = useCallback(() => {
    clearSession();
    setClearSessionConfirmOpen(false);
    setStatusMessage("Session cleared.");
  }, [clearSession]);

  const applySettingsDraftPatch = useCallback((patch: Partial<AppSettings>) => {
    setSettingsDraft((prev) => ({ ...prev, ...patch }));
    setSettingsDraftEdited(true);
    setSettingsSavedNotice(null);
  }, []);

  const openSettings = useCallback(() => {
    setSettingsDraft({ ...settings });
    setSettingsDraftEdited(false);
    setSettingsSavedNotice(null);
    setSettingsDiscardConfirmOpen(false);
    setSettingsOpen(true);
  }, [settings]);

  const closeSettingsWithoutSave = useCallback(() => {
    if (settingsDraftEdited) {
      setSettingsDiscardConfirmOpen(true);
      return;
    }
    setSettingsSavedNotice(null);
    setSettingsOpen(false);
  }, [settingsDraftEdited]);

  const keepEditingSettings = useCallback(() => {
    setSettingsDiscardConfirmOpen(false);
  }, []);

  const discardSettingsAndClose = useCallback(() => {
    setSettingsDiscardConfirmOpen(false);
    setSettingsSavedNotice(null);
    setSettingsOpen(false);
  }, []);

  const saveSettingsAndClose = useCallback(() => {
    setSettings(settingsDraft);
    setSettingsDraftEdited(false);
    setSettingsDiscardConfirmOpen(false);
    setSettingsSavedNotice("Settings saved.");
  }, [settingsDraft]);

  const resetSettingsToDefaults = useCallback(() => {
    setSettingsDraft({ ...DEFAULT_SETTINGS });
    setSettingsDraftEdited(true);
    setSettingsDiscardConfirmOpen(false);
    setSettingsSavedNotice(null);
  }, []);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsDiscardConfirmOpen && event.key === "Escape") {
        event.preventDefault();
        setSettingsDiscardConfirmOpen(false);
        return;
      }
      if (event.key === "Escape") {
        closeSettingsWithoutSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, settingsDiscardConfirmOpen, closeSettingsWithoutSave]);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && clearSessionConfirmOpen) {
        event.preventDefault();
        closeClearSessionConfirm();
        return;
      }

      const target = event.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (settingsOpen || clearSessionConfirmOpen) {
          return;
        }
        if (chatInput.trim() && !isChatLoading) {
          event.preventDefault();
          void runChatTurn(chatInput, "typed", "Question");
        }
        return;
      }

      if (settingsOpen || clearSessionConfirmOpen) {
        return;
      }

      if (isEditable || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        if (isRecording) {
          void stopRecording();
        } else {
          void startRecording();
        }
        return;
      }
      if (key === "s") {
        event.preventDefault();
        if (!settingsOpen) {
          openSettings();
        }
      }
    };

    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [
    chatInput,
    clearSessionConfirmOpen,
    closeClearSessionConfirm,
    isChatLoading,
    openSettings,
    runChatTurn,
    settingsOpen,
    isRecording,
    startRecording,
    stopRecording,
  ]);

  const sortedTranscript = useMemo(
    () =>
      [...transcript].sort(
        (first, second) =>
          new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
      ),
    [transcript],
  );
  const statusSuffix = [
    isTranscribing ? "transcribing" : "",
    isGeneratingSuggestions ? "generating suggestions" : "",
    isChatLoading ? "chatting" : "",
  ]
    .filter(Boolean)
    .join(" • ");
  const statusDisplay =
    statusMessage === "Idle" && !statusSuffix
      ? ""
      : [statusMessage !== "Idle" ? statusMessage : "", statusSuffix].filter(Boolean).join(" • ");
  const showHeaderStatusChip =
    !!statusDisplay && !statusDisplay.toLowerCase().startsWith("reloading suggestions");

  const renderAssistantMessage = (content: string) => {
    const lines = String(content || "").split(/\r?\n/);
    return lines.map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return <br key={`assistant-line-${index}`} />;
      }

      const titleMatch = CHAT_SECTION_TITLES.find((title) =>
        trimmed.toLowerCase().startsWith(title.toLowerCase()),
      );
      if (titleMatch) {
        const remainder = trimmed.slice(titleMatch.length).replace(/^:\s*/, "");
        return (
          <p key={`assistant-line-${index}`}>
            <strong>{titleMatch}</strong>
            {remainder ? ` ${remainder}` : ""}
          </p>
        );
      }

      return <p key={`assistant-line-${index}`}>{line}</p>;
    });
  };

  return (
    <main className="app-shell">
      <header className="header">
        <div>
          <p className="app-overline">TwinMind</p>
          <h1>Meeting Copilot</h1>
        </div>
        <div className="header-meta">
          {showHeaderStatusChip ? <span>{statusDisplay}</span> : null}
          <span>{isRecording ? "Mic On" : "Mic Off"}</span>
        </div>
      </header>

      <section className="controls">
        <div className="key-row">
          <button type="button" className="btn btn-secondary" onClick={openSettings}>
            Settings
          </button>
          <label htmlFor="apiKey">Groq API key</label>
          <input
            id="apiKey"
            type="password"
            placeholder="gsk_..."
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
        <div className="button-row">
          <button className="btn btn-secondary" onClick={manualRefresh} disabled={!isRecording}>
            Refresh Transcript Now
          </button>
          <button type="button" className="btn btn-secondary" onClick={openClearSessionConfirm}>
            Clear Session
          </button>
          <button className="btn btn-secondary btn-export" onClick={exportSession}>
            Export Session JSON
          </button>
        </div>
      </section>

      {settingsOpen ? (
        <div
          className="settings-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label="App settings"
        >
          <header className="settings-fullscreen-header">
            <button type="button" className="btn btn-secondary" onClick={closeSettingsWithoutSave}>
              Back to App
            </button>
          </header>
          <div className="settings-fullscreen-body">
            <div className="settings-grid settings-grid-fullscreen">
              <label>
                Suggestion context window
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={settingsDraft.suggestionContextWindow}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      suggestionContextWindow: Number(event.target.value || 1),
                    })
                  }
                />
              </label>
              <label>
                Chat context window
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={settingsDraft.chatContextWindow}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      chatContextWindow: Number(event.target.value || 1),
                    })
                  }
                />
              </label>
              <label>
                Detailed answer context window (on suggestion click)
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={settingsDraft.detailedAnswerContextWindow}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      detailedAnswerContextWindow: Number(event.target.value || 1),
                    })
                  }
                />
              </label>
              <label>
                Live suggestion system prompt
                <textarea
                  rows={10}
                  value={settingsDraft.liveSuggestionSystemPrompt}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      liveSuggestionSystemPrompt: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Live suggestion user prompt template (use {"{{context}}"} and{" "}
                {"{{recent_suggestions}}"})
                <textarea
                  rows={12}
                  value={settingsDraft.liveSuggestionUserPromptTemplate}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      liveSuggestionUserPromptTemplate: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Detailed answer system prompt (clicking suggestions)
                <textarea
                  rows={12}
                  value={settingsDraft.detailedAnswerSystemPrompt}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      detailedAnswerSystemPrompt: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Chat system prompt
                <textarea
                  rows={10}
                  value={settingsDraft.chatSystemPrompt}
                  onChange={(event) =>
                    applySettingsDraftPatch({
                      chatSystemPrompt: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          </div>
          <footer className="settings-fullscreen-footer">
            {settingsSavedNotice ? (
              <span className="settings-saved-notice">{settingsSavedNotice}</span>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={resetSettingsToDefaults}
            >
              Reset to Defaults
            </button>
            <button type="button" className="btn btn-primary" onClick={saveSettingsAndClose}>
              Save
            </button>
          </footer>
        </div>
      ) : null}

      {clearSessionConfirmOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Clear session">
          <div className="confirm-modal">
            <h3>Clear current session?</h3>
            <p>This removes transcript, suggestions, and chat history for this run.</p>
            <div className="confirm-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={closeClearSessionConfirm}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmClearSession}>
                Clear Session
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsDiscardConfirmOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Unsaved settings warning"
        >
          <div className="confirm-modal">
            <h3>Unsaved settings changes</h3>
            <p>You have unsaved edits. Save before leaving, or discard and go back to app.</p>
            <div className="confirm-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={keepEditingSettings}>
                Keep Editing
              </button>
              <button type="button" className="btn btn-danger" onClick={discardSettingsAndClose}>
                Discard and Back
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid-three">
        <section className="transcript-panel">
          <div className="panel-header">
            <h2 className="panel-title">1. Mic & Transcript</h2>
            <div className="panel-header-actions">
              <button
                className={`btn ${isRecording ? "btn-danger" : "btn-primary"}`}
                onClick={toggleRecording}
              >
                {isRecording ? "Stop Mic" : "Start Mic"}
              </button>
              <span className="panel-badge">{isRecording ? "Live" : "Idle"}</span>
            </div>
          </div>
          <div className="transcript-list">
            {isRecording ? (
              <div className="listening-chip" aria-live="polite">
                <span className="listening-dot" />
                <span>Listening... transcript updates every 30s.</span>
              </div>
            ) : null}
            {!isRecording && sortedTranscript.length === 0 ? (
              <p className="panel-note">
                The transcript updates every ~30 seconds while recording and auto-scrolls to the
                latest chunk. Use Export Session JSON anytime to download your full session.
              </p>
            ) : null}
            {sortedTranscript.length === 0 ? (
              <p className="empty">No transcript yet - start the mic.</p>
            ) : (
              sortedTranscript.map((entry) => (
                <article key={entry.id} className="transcript-live-card">
                  <div className="meta">
                    <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                    <span>
                      {`${(entry.wallSliceSeconds ?? entry.durationSeconds).toFixed(1)}s`}
                    </span>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </section>

        <section className="suggestions-panel">
          <div className="panel-header">
            <h2 className="panel-title">2. Live Suggestions</h2>
            <div className="panel-header-actions">
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => void reloadSuggestions()}
                disabled={isGeneratingSuggestions || sortedTranscript.length === 0}
              >
                Reload Suggestions
              </button>
              <span className="panel-badge">{suggestionBatches.length} batches</span>
            </div>
          </div>
          <div className="suggestions-list">
            {suggestionBatches.length === 0 ? (
              <p className="panel-note">
                Every reload (or auto ~30s) gives 3 fresh suggestions from what was just said. New
                suggestions show at the top; older ones move down. Tap cards for quick{" "}
                <span className="inline-type inline-type-question">question</span>,{" "}
                <span className="inline-type inline-type-talking-point">talking point</span>,{" "}
                <span className="inline-type inline-type-answer">answer</span>, or{" "}
                <span className="inline-type inline-type-fact-check">fact-check</span> support.
              </p>
            ) : null}
            {suggestionBatches.length === 0 ? (
              <p className="empty">Suggestions appear here once recording starts.</p>
            ) : (
              suggestionBatches.map((batch) => (
                <article key={batch.id} className="suggestion-batch">
                  <div className="meta">
                    <span>Batch #{suggestionBatches.length - suggestionBatches.indexOf(batch)}</span>
                    <span>{new Date(batch.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {batch.suggestions.map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion.id}
                      className="suggestion-card"
                      onClick={() =>
                        void runChatTurn(
                          suggestion.preview,
                          "suggestion",
                          formatSuggestionTypeLabel(suggestion.type),
                        )
                      }
                    >
                      <div className={`suggestion-type suggestion-type-${suggestion.type}`}>
                        {suggestion.type}
                      </div>
                      <p>{suggestion.preview}</p>
                      <small>{suggestion.reason}</small>
                    </button>
                  ))}
                </article>
              ))
            )}
          </div>
        </section>

        <section className="chat-panel">
          <div className="panel-header">
            <h2 className="panel-title">3. Chat (Detailed Answers)</h2>
            <div className="panel-header-actions">
              <span className="panel-badge">Session-only</span>
            </div>
          </div>
          <div className="chat-list">
            {chatMessages.length === 0 ? (
              <p className="panel-note">
                Tap a suggestion to open a fuller answer here. You can also type your own
                question. This is one continuous chat for your current session only.
              </p>
            ) : null}
            {chatMessages.length === 0 ? (
              <p className="empty">Click a suggestion or type a question below.</p>
            ) : (
              chatMessages.map((message) => (
                <article
                  key={message.id}
                  className={`chat-message ${message.role === "user" ? "user" : "assistant"}`}
                >
                  <div className="meta">
                    <span>
                      {message.role === "user"
                        ? message.userTag
                          ? `You · ${message.userTag}`
                          : "You"
                        : "Assistant"}
                    </span>
                    <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {message.role === "assistant" ? (
                    <div className="chat-assistant-content">
                      {renderAssistantMessage(message.content)}
                    </div>
                  ) : (
                    <p>{message.content}</p>
                  )}
                </article>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-form" onSubmit={onSubmitChat}>
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask anything about the meeting..."
              disabled={isChatLoading}
            />
            <button type="submit" disabled={isChatLoading || !chatInput.trim()}>
              Send
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

export default App;
