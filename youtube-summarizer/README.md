# YouTube summary (OpenCode Go)

Chrome extension. On a YouTube watch page it reads the captions and asks [OpenCode Go](https://opencode.ai/docs/go/) for a summary.

1. Subscribe to OpenCode Go and copy the API key from the console (`opencode.ai/auth`).
2. Open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**.
3. Select this `youtube-summarizer` folder.
4. Open a YouTube video that has captions, click the extension, paste the key, and press **Summarize this video**.

The key stays in `chrome.storage.local` on this browser. The transcript is sent to `https://opencode.ai/zen/go/v1`. OpenCode Go is priced and monitored as coding-agent traffic, so a long video spends the same quota as a long prompt.

Videos with no captions cannot be summarized. Grok, GPT, Claude, MiniMax, and Qwen model ids use the `/responses` or `/messages` route from the Go docs; the rest use `/chat/completions`.
