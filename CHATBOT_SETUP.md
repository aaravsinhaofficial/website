# Chatbot setup

The browser widget in `script.js` calls `/api/chat`. The API route in `api/chat.js` runs server-side and reads your key from `process.env.OPENAI_API_KEY`, so the key is never shipped to the browser or committed to GitHub.

## Deploy securely

1. Deploy this repository on a host that supports serverless functions, such as Vercel.
2. Add `OPENAI_API_KEY` as an environment variable in the host dashboard.
3. Optionally add `OPENAI_MODEL` to override the default lightweight model.
4. Optionally tune web search and rate limiting with the variables below.
5. Redeploy after adding or changing environment variables.

GitHub Pages alone cannot securely run this chatbot because it only serves static files. If you keep using GitHub Pages, the widget code can be public, but `/api/chat` will not execute there.

## Local secrets

Keep local keys in `.env`, which is ignored by Git:

```sh
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-4.1-mini
OPENAI_WEB_SEARCH=true
OPENAI_SEARCH_CONTEXT_SIZE=medium
OPENAI_MAX_OUTPUT_TOKENS=900
CHAT_RATE_LIMIT_MAX_REQUESTS=60
CHAT_RATE_LIMIT_WINDOW_MS=600000
```

`OPENAI_WEB_SEARCH=false` disables web search. `OPENAI_SEARCH_CONTEXT_SIZE` can be `low`, `medium`, or `high`; higher settings can improve detailed answers but may increase cost and latency.

Never paste the API key into `index.html`, `script.js`, or any other browser-delivered file.
