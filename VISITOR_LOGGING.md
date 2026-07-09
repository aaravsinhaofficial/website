# Visitor Logging

The site records page views by calling `/api/visit` from `script.js`.

On Vercel, each visit is written as one JSON line in the function logs. The log
includes:

- timestamp
- page path and title
- referrer
- browser user agent
- Vercel geo headers when available
- visitor IP, depending on `VISITOR_LOG_IP_MODE`

## Vercel environment variables

`VISITOR_LOG_IP_MODE` controls what gets written for the visitor IP:

- `raw` records the raw IP address. This is the default.
- `hash` records a SHA-256 hash of the IP address.
- `truncate` records a shortened IP prefix.
- `off` omits IP addresses from visit logs.

If you use `hash`, set `VISITOR_LOG_IP_SALT` to a private random value in
Vercel so hashes are harder to reverse.

For durable storage outside Vercel's log retention window, set:

- `VISITOR_LOG_WEBHOOK_URL`
- `VISITOR_LOG_WEBHOOK_TOKEN` if the webhook expects a bearer token

The client-side tracker respects browser Do Not Track and Global Privacy
Control signals.
