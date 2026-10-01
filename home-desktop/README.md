# Home Desktop

Private full-Mac access at https://aaravsinha.dev/desktop, alongside Home Browser.

## Connection

The website serves a bundled noVNC 1.7 client. HTTPS and WebSockets stay on aaravsinha.dev. Vercel's desktop relay resolves the same fixed discovery Gist used by Home Browser and forwards only `/desktop/session` to the home gateway. The gateway requires a separate desktop session before connecting a binary WebSocket to the fixed loopback VNC endpoint `127.0.0.1:5900`.

The Mac's built-in Screen Sharing performs its own ARD authentication. Enter the Mac account name and password in the desktop viewer when prompted. Mac credentials stay in the page's memory for reconnects and are not saved to local storage or a server config. The page clears them on logout or close. Authentication transport and all website resources use the same website origin.

## Initial setup

1. Install dependencies with `npm ci` in the repository root. Keep the existing Home Browser supervisor installed.
2. Run `node home-desktop/enroll.mjs setup`. It creates a private configuration outside this repository, using the current Home Browser password hash and a separate session secret and authenticator secret. Re-running it preserves existing configuration.
3. Run `node home-desktop/enroll.mjs enroll` and open the local address it prints on the home Mac. Add the QR code to your authenticator and confirm its six-digit code. Enrollment is available only on loopback, expires after 15 minutes, and is never exposed through the tunnel.
4. Restart the Home Browser gateway process after initial configuration. The launchd supervisor recreates it; the browser's Chrome container does not need to restart.
5. Open `/desktop`, enter the existing website password plus a fresh authenticator code, then enter the Mac's login when asked.

Native Screen Sharing must be enabled in System Settings → General → Sharing, with access restricted to the intended Mac account. Do not configure router port forwarding for VNC. The gateway always uses loopback; VNC remains protected by macOS account authentication.

## Persistence and limitations

The existing Home Browser launch agent starts the shared gateway and tunnel at Mac login and prevents idle system sleep. Leave the Mac powered on, plugged in, logged in, awake, and connected. Closing the lid, deliberately sleeping, shutting down, losing power, or disconnecting the network interrupts access. After a reboot, FileVault may require a local unlock before the user launch agent can start.

The viewer controls the actual logged-in desktop. Local activity and remote activity share the same apps and windows. Closing or locking the viewer does not log out or lock macOS. The website session lasts at most four hours; locking it closes its active WebSockets. Vercel's five-minute WebSocket lifetime causes periodic reconnects, while Mac apps remain open.

Standard VNC does not provide Apple's High Performance screen-sharing transport or system audio. Fit screen scales the image locally; it does not lower the captured Mac resolution. Large Retina displays, heavy Mac workloads, and network latency can still affect responsiveness.

## Maintenance

- Build frontend: `npm run build:desktop` (commit the generated `desktop/desktop.js` and license).
- Tests: `npm run test:browser`, `npm run test:desktop`, and `npm test --prefix home-browser/gateway`.
- Private state: `~/Library/Application Support/aarav-home-desktop/config.json` (0600 in a 0700 directory). Never commit or publish it. It contains the authenticator secret; a backup of it is sensitive.
- The desktop password hash is copied at initial setup. Later browser password changes do not automatically change the desktop password.
- If the authenticator is lost, a local administrator can re-enroll by deliberately replacing the desktop authentication configuration. There is no public password-only recovery or remote registration endpoint.
- Bundled noVNC is licensed under MPL-2.0; see `desktop/novnc-LICENSE.txt`. Its source is available through the pinned `@novnc/novnc` npm dependency.
