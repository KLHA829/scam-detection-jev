import { DEFAULT_MODEL, MODELS, videoIdFromUrl } from "./lib.js";

const keyInput = document.querySelector("#key");
const modelSelect = document.querySelector("#model");
const videoLine = document.querySelector("#video");
const button = document.querySelector("#go");
const status = document.querySelector("#status");
const summary = document.querySelector("#summary");

for (const [id, label] of MODELS) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = label;
  modelSelect.append(option);
}
modelSelect.value = DEFAULT_MODEL;

const stored = await chrome.storage.local.get(["apiKey", "model", "sessionId"]);
if (stored.apiKey) keyInput.value = stored.apiKey;
if (MODELS.some(([id]) => id === stored.model)) modelSelect.value = stored.model;
const sessionId = stored.sessionId || crypto.randomUUID();
if (!stored.sessionId) await chrome.storage.local.set({ sessionId });

keyInput.addEventListener("change", () => chrome.storage.local.set({ apiKey: keyInput.value.trim() }));
modelSelect.addEventListener("change", () => chrome.storage.local.set({ model: modelSelect.value }));

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const videoId = videoIdFromUrl(tab?.url || "");
videoLine.textContent = videoId ? `This tab: ${videoId}` : "Open a YouTube video, then come back.";
button.disabled = !videoId;

button.addEventListener("click", async () => {
  button.disabled = true;
  status.className = "";
  status.textContent = "Reading captions…";
  summary.textContent = "";
  const reply = await chrome.runtime.sendMessage({
    type: "summarize",
    apiKey: keyInput.value.trim(),
    model: modelSelect.value,
    sessionId,
    pageUrl: tab.url,
    tabId: tab.id,
    lang: navigator.language,
  });
  button.disabled = false;
  if (!reply || reply.error) {
    status.className = "error";
    status.textContent = reply?.error || "The extension did not answer. Reload it from chrome://extensions.";
    return;
  }
  status.textContent = "";
  summary.textContent = reply?.summary || "";
});
