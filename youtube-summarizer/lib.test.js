import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoRequest,
  captionTracksFromPlayer,
  completeSummary,
  extractPlayerResponse,
  pickCaptionTrack,
  summaryText,
  transcriptFromJson3,
  videoIdFromUrl,
} from "./lib.js";

test("video id from watch, shorts, and youtu.be", () => {
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("https://example.com/watch?v=dQw4w9WgXcQ"), null);
});

test("player response keeps braces that appear inside strings", () => {
  const html =
    'before ytInitialPlayerResponse = {"videoDetails":{"title":"a { b } c","videoId":"abcdefghijk"},' +
    '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
    '{"baseUrl":"https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en","languageCode":"en","kind":"asr"},' +
    '{"baseUrl":"https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-manual","languageCode":"en"}' +
    ']}}}; after';
  const player = extractPlayerResponse(html);
  assert.equal(player.videoDetails.title, "a { b } c");
  const picked = pickCaptionTrack(captionTracksFromPlayer(player), "en");
  assert.equal(picked.kind, undefined);
  assert.match(picked.baseUrl, /en-manual/);
  const englishAuto = pickCaptionTrack(
    [
      { baseUrl: "https://www.youtube.com/api/timedtext?lang=zh", languageCode: "zh" },
      { baseUrl: "https://www.youtube.com/api/timedtext?lang=en", languageCode: "en", kind: "asr" },
    ],
    "en-US",
  );
  assert.equal(englishAuto.languageCode, "en");
});

test("json3 events become one transcript", () => {
  const text = transcriptFromJson3({
    events: [{ segs: [{ utf8: "Hello " }, { utf8: "there" }] }, { segs: [{ utf8: "\nfriend" }] }],
  });
  assert.equal(text, "Hello there friend");
});

test("Go request uses the endpoint for that model and keeps the key out of the body", async () => {
  const chat = buildGoRequest({
    model: "deepseek-v4-flash",
    title: "Demo",
    transcript: "words",
    clipped: false,
    apiKey: "secret-key",
    sessionId: "sess-1",
  });
  assert.equal(chat.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(chat.headers.Authorization, "Bearer secret-key");
  assert.equal(chat.headers["x-opencode-session"], "sess-1");
  assert.equal(JSON.stringify(chat.body).includes("secret-key"), false);

  const grok = buildGoRequest({
    model: "grok-4.7",
    title: "Demo",
    transcript: "words",
    clipped: false,
    apiKey: "secret-key",
    sessionId: "sess-1",
  });
  assert.match(grok.url, /\/responses$/);

  const claude = buildGoRequest({
    model: "claude-haiku-5-5",
    title: "Demo",
    transcript: "words",
    clipped: false,
    apiKey: "secret-key",
    sessionId: "sess-1",
  });
  assert.match(claude.url, /\/messages$/);

  let seen;
  const summary = await completeSummary({
    apiKey: "secret-key",
    model: "deepseek-v4-flash",
    sessionId: "sess-1",
    title: "Demo",
    transcript: "The talk is about batteries.",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Batteries." } }] }) };
    },
  });
  assert.equal(summary, "Batteries.");
  assert.match(seen.init.body, /batteries/);
  assert.equal(summaryText({ output: [{ content: [{ text: "From responses" }] }] }), "From responses");
});
