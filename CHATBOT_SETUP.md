# Chatbot setup

The browser widget in `script.js` calls `/api/chat`. The API route in `api/chat.js` runs server-side and reads your key from `process.env.OPENAI_API_KEY`, so the key is never shipped to the browser or committed to GitHub.

## Deploy securely

1. Deploy this repository on a host that supports serverless functions, such as Vercel.
2. Add `OPENAI_API_KEY` as an environment variable in the host dashboard.
3. Optionally add `OPENAI_MODEL` to override the default lightweight model.
4. Redeploy after adding or changing environment variables.

GitHub Pages alone cannot securely run this chatbot because it only serves static files. If you keep using GitHub Pages, the widget code can be public, but `/api/chat` will not execute there.

## Local secrets

Keep local keys in `.env`, which is ignored by Git:

```sh
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-4.1-mini
```

Never paste the API key into `index.html`, `script.js`, or any other browser-delivered file.
