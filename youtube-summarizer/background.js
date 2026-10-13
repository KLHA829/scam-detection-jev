import {
  captionTracksFromPlayer,
  completeSummary,
  DEFAULT_MODEL,
  extractPlayerResponse,
  json3Url,
  pickCaptionTrack,
  transcriptFromJson3,
  videoIdFromUrl,
} from "./lib.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "summarize") return;
  run(message).then(
    (summary) => sendResponse({ summary }),
    (err) => sendResponse({ error: err.message || "Could not summarize this video." }),
  );
  return true;
});

async function run(message) {
  const { apiKey, model, sessionId, pageUrl, tabId, lang } = message;
  if (!apiKey?.trim()) throw new Error("Add your OpenCode Go API key first.");
  const videoId = videoIdFromUrl(pageUrl);
  if (!videoId) throw new Error("Open a YouTube video first.");
  const video = await loadVideo(tabId, videoId);
  const track = pickCaptionTrack(video.tracks, lang || "en");
  if (!track?.baseUrl) throw new Error("This video has no captions to summarize.");
  const captionRes = await fetch(json3Url(track.baseUrl), { credentials: "include" });
  if (!captionRes.ok) throw new Error("YouTube did not return the captions.");
  const captionJson = await captionRes.json().catch(() => null);
  if (!captionJson) throw new Error("YouTube did not return caption text.");
  const transcript = transcriptFromJson3(captionJson);
  return completeSummary({
    apiKey,
    model: model || DEFAULT_MODEL,
    sessionId,
    title: video.title,
    transcript,
    fetchImpl: fetch,
  });
}

async function loadVideo(tabId, videoId) {
  const fromPlayer = await playerOnTab(tabId);
  if (fromPlayer?.tracks?.length) return fromPlayer;
  const htmlRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: "include" });
  if (!htmlRes.ok) return fromPlayer || { title: "", tracks: [] };
  const player = extractPlayerResponse(await htmlRes.text());
  const tracks = captionTracksFromPlayer(player);
  if (tracks.length) {
    return { title: player?.videoDetails?.title || fromPlayer?.title || "", tracks };
  }
  return fromPlayer || { title: player?.videoDetails?.title || "", tracks: [] };
}

async function playerOnTab(tabId) {
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const nodes = [
          document.getElementById("movie_player"),
          ...document.querySelectorAll(".html5-video-player"),
        ];
        let response = null;
        for (const node of nodes) {
          const got = node?.getPlayerResponse?.();
          if (got?.videoDetails?.videoId) {
            response = got;
            break;
          }
        }
        if (!response) return null;
        const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return {
          title: response.videoDetails.title || "",
          tracks: tracks.map((track) => ({
            baseUrl: track.baseUrl,
            languageCode: track.languageCode || "",
            kind: track.kind || "",
          })),
        };
      },
    });
    return hit?.result || null;
  } catch {
    return null;
  }
}
