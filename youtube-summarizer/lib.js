export const GO_BASE = "https://opencode.ai/zen/go/v1";
export const DEFAULT_MODEL = "deepseek-v4-flash";
// shortcut: one cap for every model, raise it when a selected model is known to take more
export const TRANSCRIPT_LIMIT = 60_000;

// Chat-completions models are the default path. The other two sets follow
// https://opencode.ai/docs/go/ — those model ids reject /chat/completions.
const RESPONSES = new Set([
  "grok-4.7",
  "grok-4.6",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
]);
const MESSAGES = new Set([
  "claude-haiku-5-5",
  "minimax-m3",
  "minimax-m2.7",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
]);

export const MODELS = [
  ["longcat-2.5-preview-free", "LongCat 2.5 Preview (free)"],
  ["step-5-preview-free", "Step 5 Preview (free)"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["glm-5.3-flash", "GLM-5.3 Flash"],
  ["glm-5.3", "GLM-5.3"],
  ["glm-5.2", "GLM-5.2"],
  ["kimi-k2.6", "Kimi K2.6"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["kimi-k3", "Kimi K3"],
  ["longcat-2.0", "LongCat 2.0"],
  ["mimo-v2.5", "MiMo V2.5"],
  ["mimo-v2.6-flash", "MiMo V2.6 Flash"],
  ["hy3", "Hy3"],
  ["hy4-preview", "Hy4 preview"],
  ["space-bunny", "Space Bunny"],
  ["grok-4.6", "Grok 4.6"],
  ["grok-4.7", "Grok 4.7"],
  ["gpt-5.6-luna", "GPT 5.6 Luna"],
  ["gpt-6-luna", "GPT 6 Luna"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ["minimax-m2.7", "MiniMax M2.7"],
  ["minimax-m3", "MiniMax M3"],
  ["qwen3.7-plus", "Qwen3.7 Plus"],
  ["qwen3.8-flash", "Qwen3.8 Flash"],
  ["qwen3.8-max", "Qwen3.8 Max"],
];

const SYSTEM =
  "Summarize this YouTube transcript for someone who has not watched the video. " +
  "Use the same language as the transcript. Lead with the point of the video, then the main points. " +
  "Include only what the transcript supports.";

export function videoIdFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return asId(url.pathname.split("/").filter(Boolean)[0]);
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") return null;
  if (url.pathname === "/watch") return asId(url.searchParams.get("v"));
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  if (kind === "shorts" || kind === "embed" || kind === "live" || kind === "v") return asId(id);
  return null;
}

function asId(id) {
  return typeof id === "string" && /^[\w-]{11}$/.test(id) ? id : null;
}

export function extractPlayerResponse(html) {
  const at = html.indexOf("ytInitialPlayerResponse");
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function captionTracksFromPlayer(player) {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

export function pickCaptionTrack(tracks, prefer = "en") {
  if (!tracks?.length) return null;
  const lang = (prefer || "en").toLowerCase();
  const matches = (track) => {
    const code = (track.languageCode || "").toLowerCase();
    return code === lang || code.startsWith(lang.slice(0, 2));
  };
  const manual = tracks.filter((track) => track.kind !== "asr");
  return manual.find(matches) || tracks.find(matches) || manual[0] || tracks[0];
}

export function json3Url(baseUrl) {
  const url = new URL(baseUrl, "https://www.youtube.com");
  url.searchParams.set("fmt", "json3");
  return url.toString();
}

export function transcriptFromJson3(data) {
  const parts = [];
  for (const event of data?.events || []) {
    for (const seg of event.segs || []) {
      if (seg.utf8) parts.push(seg.utf8);
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function clipTranscript(text) {
  if (text.length <= TRANSCRIPT_LIMIT) return { text, clipped: false };
  return { text: text.slice(0, TRANSCRIPT_LIMIT), clipped: true };
}

export function endpointKind(model) {
  if (RESPONSES.has(model)) return "responses";
  if (MESSAGES.has(model)) return "messages";
  return "chat";
}

export function buildGoRequest({ model, title, transcript, clipped, apiKey, sessionId }) {
  const note = clipped ? "\n\nThe transcript was cut at 60000 characters." : "";
  const user = `Title: ${title || "Untitled"}\n\nTranscript:\n${transcript}${note}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "x-opencode-session": sessionId,
  };
  const kind = endpointKind(model);
  if (kind === "responses") {
    return {
      url: `${GO_BASE}/responses`,
      headers,
      body: { model, instructions: SYSTEM, input: user },
    };
  }
  if (kind === "messages") {
    return {
      url: `${GO_BASE}/messages`,
      headers,
      body: { model, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: user }] },
    };
  }
  return {
    url: `${GO_BASE}/chat/completions`,
    headers,
    body: { model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] },
  };
}

export function summaryText(json) {
  const choice = json?.choices?.[0]?.message?.content;
  const fromChoice = textOf(choice);
  if (fromChoice) return fromChoice.trim();
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  const fromResponses = (json?.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
  if (fromResponses) return fromResponses;
  return (json?.content || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || "").join("");
  return "";
}

export async function completeSummary({ apiKey, model, sessionId, title, transcript, fetchImpl }) {
  if (!apiKey?.trim()) throw new Error("Add your OpenCode Go API key first.");
  const clip = clipTranscript(transcript || "");
  if (!clip.text) throw new Error("This video has no caption text.");
  const req = buildGoRequest({
    model: model || DEFAULT_MODEL,
    title,
    transcript: clip.text,
    clipped: clip.clipped,
    apiKey: apiKey.trim(),
    sessionId,
  });
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `${res.status}`;
    throw new Error(`OpenCode Go: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  const text = summaryText(json);
  if (!text) throw new Error("OpenCode Go returned an empty summary.");
  return text;
}
