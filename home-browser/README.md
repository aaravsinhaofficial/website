# Home Browser

The website opens a dedicated Google Chrome session running in Docker on the home Mac. Chrome makes website requests through the Mac's current internet connection; only the browser display, audio, keyboard, mouse, and file transfers travel through the tunnel. This does not change the network of other apps on the remote device.

Vercel hosts `/browser/`. A local password gateway protects both the browser page and its WebSocket connections. Cloudflare forwards HTTPS traffic to that gateway. The Chrome container listens only on `127.0.0.1:3080`, the gateway on `127.0.0.1:3081`. No router ports or GoDaddy DNS changes are needed for this version.

## Start on the home Mac

Install Node.js 22 or later, Docker Desktop, GitHub CLI (`gh`), and `cloudflared`. Sign in with `gh auth login` if needed. Run these commands from this repository:

```sh
npm ci --prefix home-browser/gateway
node home-browser/manage.mjs setup
node home-browser/manage.mjs install
node home-browser/manage.mjs start
node home-browser/manage.mjs status
```

Setup is idempotent: it retains the existing password, browser profile, and discovery Gist. It writes the website's `browser/connection.json`, which should be committed and deployed. That file contains only a public discovery URL. The supervisor runs at login, opens Docker Desktop if necessary, and restarts gateway/tunnel processes with backoff. Discovery updates when the URL changes; failed updates retry once per minute.

The generated 32-character login password is stored only at:

```text
~/Library/Application Support/aarav-home-browser/access.txt
```

Open that file locally to retrieve it. The state directory is private to the Mac user (`0700`); configuration and access files use `0600`. Password hashes and session signing secrets remain outside the repository. Never commit those files, browser profiles, cookies, or `.env` credentials.

Visit `https://aaravsinha.dev/browser/`, open the Home Browser login, and enter the generated password. Authenticate in its own window if an embedded browser blocks cookies. Log into Google, ChatGPT, and other sites inside this dedicated session yourself. Those sessions persist in the `aarav-home-browser_chrome-profile` Docker volume.

## Stop and diagnose

```sh
node home-browser/manage.mjs stop
node home-browser/manage.mjs status
docker compose -f home-browser/compose.yaml logs --tail 100 chrome
```

`stop` unloads the login service and stops Chrome, retaining its profile. `start` loads it again. The supervisor log is in the private state directory. `run` runs the supervisor in the foreground for diagnosis; do not run it while the launch agent is already active.

The Mac must stay at home, powered on, logged in, online, and running Docker Desktop. While the service runs, `caffeinate -i` prevents idle system sleep. It does not override closing the laptop lid, explicit sleep, power loss, or shutdown. After a reboot, log into the Mac to start its user launch agent and Docker Desktop. Moving the Mac to another network also moves the browser's internet exit connection.

## Discovery and availability

This first version uses a **Cloudflare Quick Tunnel**, a development service with no uptime guarantee. Its hostname changes whenever the tunnel restarts. An **unlisted GitHub Gist** publishes only `{url, updatedAt}` so the website can discover the current endpoint without a redeploy. Unlisted is not private: anyone with the Gist URL can read the tunnel address. The gateway password is the access control, and neither the Gist nor the website contains it.

GitHub availability, caching, rate limits, and the local `gh` login affect discovery updates. Quick Tunnels also have service limits and may disconnect. A temporary interruption can require reopening the browser from `/browser/`; browser cookies remain in the local volume. ChatGPT's own streaming runs inside Chrome and does not rely on Quick Tunnel SSE support.

For a stable production hostname, replace the Quick Tunnel with a named Cloudflare Tunnel and put identity-based Cloudflare Access in front of it. Keep GoDaddy as registrar and Vercel as the website host; Cloudflare's normal named-tunnel setup requires the domain's DNS on Cloudflare. Preserve existing website and mail records when making that later change. No DNS migration is performed by these scripts.

## Browser behavior and isolation

Selkies streams the full Chrome application, including tabs and dialogs. The configured transport is WebSockets through the authenticated gateway. WebRTC transport, session sharing, terminal commands, and sudo are disabled. The container has its own persistent volume and no host-directory mounts, privileged mode, or Docker socket. Transfers are explicitly enabled despite desktop hardening; use the Selkies sidebar to move files between your device and the remote browser. Clipboard transfer is available through the sidebar; automatic clipboard synchronization starts disabled.

Your current network still needs to reach the website, GitHub's raw Gist service, and the generated `trycloudflare.com` endpoint. Sites may show bot checks or require reauthentication. DRM playback, hardware passkeys, webcams, and browser shortcuts may differ from local Chrome. There is no guarantee that every site or media feature works through a remote browser.

## Upstream documentation

- [LinuxServer Chrome image](https://docs.linuxserver.io/images/docker-chrome/)
- [Selkies configuration](https://docs.linuxserver.io/selkies/user-guide/configuration/)
- [Selkies security](https://docs.linuxserver.io/selkies/user-guide/security/)
- [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Named Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)
