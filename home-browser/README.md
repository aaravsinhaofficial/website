# Home Browser

The website opens a dedicated Google Chrome session running in Docker on the home Mac. Chrome makes website requests through the Mac's current internet connection; only the browser display, audio, keyboard, mouse, and file transfers travel through the tunnel. This does not change the network of other apps on the remote device.

Vercel hosts `/browser/` and relays the session's HTTP and WebSocket traffic at `/browser/session/`. The viewer's login, assets, display stream, health checks, and controls use the same `aaravsinha.dev` origin. The server relay discovers the current Cloudflare endpoint through a GitHub Gist, then forwards requests through Cloudflare to the password gateway at home. The viewer does not fetch GitHub or connect directly to the tunnel.

The local password gateway protects both the browser page and its WebSocket connections. Chrome listens only on `127.0.0.1:3080`, and the gateway on `127.0.0.1:3081`. No router ports or GoDaddy DNS changes are needed.

## Start on the home Mac

Install Node.js 22 or later, Docker Desktop with Docker Compose 2.30 or later, GitHub CLI (`gh`), and `cloudflared`. Sign in with `gh auth login` if needed. Run these commands from this repository:

```sh
npm ci
npm ci --prefix home-browser/gateway
node home-browser/manage.mjs setup
node home-browser/manage.mjs install
node home-browser/manage.mjs start
node home-browser/manage.mjs status
```

Setup is idempotent: it retains the existing password, browser profile, and discovery Gist. It writes `browser/connection.json`, which should be committed and deployed with the Vercel relay and root package files. That file contains only a public discovery URL; the relay reads it on the server. The supervisor runs at login, opens Docker Desktop if necessary, and restarts gateway/tunnel processes with backoff. Discovery updates when the URL changes; failed updates retry once per minute.

The login password is saved privately at:

```text
~/Library/Application Support/aarav-home-browser/access.txt
```

Open that file locally to retrieve it. The state directory is private to the Mac user (`0700`); configuration and access files use `0600`. Password hashes and session signing secrets remain outside the repository. Never commit those files, browser profiles, cookies, or `.env` credentials.

Visit `https://aaravsinha.dev/browser/` and enter the saved password. **Open session** opens the same session in a separate tab on the website. Log into Google, ChatGPT, and other sites inside this dedicated browser yourself. The profile is stored in the `aarav-home-browser_chrome-profile` Docker volume.

## Keep the session available

Keep the home laptop plugged in, with its lid open, powered on, logged in, online, and running Docker Desktop. While the service runs, `caffeinate -i` prevents idle system sleep. The display can turn off while the laptop stays awake. Closing the lid, choosing Sleep, losing power, or shutting down can interrupt access; a powered-off laptop cannot run the browser. After a reboot, log into the Mac to start its user launch agent and Docker Desktop. Moving the laptop to another network also moves the browser's internet exit connection.

Closing `/browser/` only disconnects the viewer. Chrome keeps running, so reopening the page reconnects to the same tabs and live page state. Locking the viewer requires the password again without ending Chrome's session.

For a planned service restart, Chrome is asked to exit gracefully and save its tabs before the container stops. `--restore-last-session` reopens those saved regular tabs on startup. After a crash or power loss, Chrome may require its **Restore** prompt. Restarted pages reload, so unsaved forms and other in-memory state are not guaranteed to survive; incognito tabs do not survive a Chrome restart. Websites can still expire logins. See [session persistence details](chrome-session/README.md).

## Stop and diagnose

```sh
node home-browser/manage.mjs stop
node home-browser/manage.mjs status
docker compose -f home-browser/compose.yaml logs --tail 100 chrome
```

`stop` unloads the login service and stops Chrome, retaining its profile. `start` loads it again. The Compose pre-stop hook gives Chrome up to 20 seconds to exit before stopping its desktop. Use the manager or `docker compose stop` for planned shutdowns; a direct `docker stop` does not run that hook. The supervisor log is in the private state directory. `run` runs the supervisor in the foreground for diagnosis; do not run it while the launch agent is already active.

## Discovery and availability

The home connection uses a **Cloudflare Quick Tunnel**, a development service with no uptime guarantee. Its hostname changes whenever the tunnel restarts. An **unlisted GitHub Gist** publishes only `{url, updatedAt}` so Vercel can discover the endpoint without a redeploy. Unlisted is not private: anyone with the Gist URL can read the tunnel address. The gateway password is the access control, and neither the Gist nor the website contains it.

GitHub availability, caching, rate limits, and the local `gh` login affect server-side discovery. Quick Tunnels also have service limits and may disconnect. A temporary interruption can require **Reconnect** or reopening `/browser/`; the Chrome session remains at home. ChatGPT's own streaming runs inside Chrome and does not rely on Quick Tunnel SSE support.

The relay uses Vercel Fluid compute with `maxDuration: 300`. Vercel closes WebSocket connections at the function's duration limit, so long sessions need stream reconnection approximately every five minutes. Reconnecting attaches to the same Chrome process; Vercel does not hold the browser's tabs or profile. If the stream does not resume automatically, use **Reconnect**. See [Vercel's WebSocket lifecycle](https://vercel.com/docs/functions/websockets).

The display stream now passes through Vercel and consumes its data-transfer and function usage allowances. Long viewing sessions or video playback can increase usage. HTTP file transfers are also subject to Vercel's payload limits; large uploads may fail. Check project usage and the current [Vercel Functions limits](https://vercel.com/docs/functions/limitations) when diagnosing quotas or transfer failures.

## Display performance

CSS scaling is enabled to stream near the viewer's CSS-pixel resolution, and the frame rate is capped at 30 fps. At a device-pixel ratio of 2, the same-sized view targets roughly one quarter of the pixels of a full Retina-resolution stream. This reduces encoding and transfer work. Responsiveness still depends on the laptop's load, home upload speed, the viewer's network, and the relay route.

## Browser behavior and isolation

Selkies streams the full Chrome application, including tabs and dialogs. The configured transport is WebSockets through the Vercel relay and authenticated home gateway. WebRTC transport, session sharing, terminal commands, and sudo are disabled. The container uses its own persistent profile volume and one read-only host-file mount for the graceful shutdown helper. It has no privileged mode or Docker socket. Transfers are explicitly enabled despite desktop hardening; use the Selkies sidebar to move files between your device and the remote browser, within the relay's transfer limits. Clipboard transfer is available through the sidebar; automatic clipboard synchronization starts disabled.

Your current network needs to reach `aaravsinha.dev` and allow its HTTPS/WebSocket traffic. The home computer and Vercel still need their backend connections to GitHub and Cloudflare. Sites inside Chrome may show bot checks or require reauthentication. DRM playback, hardware passkeys, webcams, and browser shortcuts may differ from local Chrome. There is no guarantee that every site or media feature works through a remote browser.

## Upstream documentation

- [LinuxServer Chrome image](https://docs.linuxserver.io/images/docker-chrome/)
- [Selkies configuration](https://docs.linuxserver.io/selkies/user-guide/configuration/)
- [Selkies security](https://docs.linuxserver.io/selkies/user-guide/security/)
- [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Docker Compose lifecycle hooks](https://docs.docker.com/compose/how-tos/lifecycle/)
- [Vercel WebSockets](https://vercel.com/docs/functions/websockets)
