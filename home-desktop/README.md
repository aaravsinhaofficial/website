# Home Desktop

Private full-Mac access at https://aaravsinha.dev/desktop, alongside Home Browser.

## Connection

The website serves a bundled noVNC 1.7 client. HTTPS and WebSockets stay on aaravsinha.dev. Vercel's desktop relay resolves the same fixed discovery Gist used by Home Browser and forwards only `/desktop/session` to the home gateway. The gateway requires a separate desktop session before connecting a binary WebSocket to the fixed loopback VNC endpoint `127.0.0.1:5900`.

The Mac's built-in Screen Sharing performs its own ARD authentication. Enter the Mac account name and password in the desktop viewer when prompted. Mac credentials stay in the page's memory for reconnects and are not saved to local storage or a server config. The page clears them on logout or close. Authentication transport and all website resources use the same website origin.

## Initial setup

1. Install dependencies with `npm ci` in the repository root. Keep the existing Home Browser supervisor installed.
2. Run `node home-desktop/setup.mjs`. It creates a private configuration outside this repository, using the current Home Browser password hash and a separate session secret. Re-running it preserves existing configuration.
3. Restart the Home Browser gateway process after initial configuration. The launchd supervisor recreates it; the browser's Chrome container does not need to restart.
4. Open `/desktop`, enter the existing website password, then enter the Mac account name and password when asked.

Native Screen Sharing must be enabled in System Settings → General → Sharing, with access restricted to the intended Mac account. Do not configure router port forwarding for VNC. The gateway always uses loopback; VNC remains protected by macOS account authentication.

## Display selection

Use the left and right arrows in the toolbar to show one physical display at a time. Displays are ordered from left to right; the main display is selected initially. The selected display is remembered in this browser when reconnecting or reopening the page. Fit screen scales the selected display, and turning it off shows that display at native size.

Display positions come from an authenticated, cached CoreGraphics query on the Mac. The viewer crops the existing VNC framebuffer and uses noVNC's coordinate translation for mouse input. It does not change Mac display settings or reduce the full framebuffer's network traffic. If the reported layout cannot safely match the incoming framebuffer, the viewer temporarily shows the full desktop and retries the display layout.

## Persistence and limitations

The existing Home Browser launch agent starts the shared gateway and tunnel at Mac login and prevents idle system sleep. Leave the Mac powered on, plugged in, logged in, awake, and connected. Closing the lid, deliberately sleeping, shutting down, losing power, or disconnecting the network interrupts access. After a reboot, FileVault may require a local unlock before the user launch agent can start.

The viewer controls the actual logged-in desktop. Local activity and remote activity share the same apps and windows. Closing or locking the viewer does not log out or lock macOS. The website session lasts at most four hours; locking it closes its active WebSockets. Vercel's five-minute WebSocket lifetime causes periodic reconnects, while Mac apps remain open.

Standard VNC does not provide Apple's High Performance screen-sharing transport or system audio. Fit screen scales the image locally; it does not lower the captured Mac resolution. Large Retina displays, heavy Mac workloads, and network latency can still affect responsiveness.

## Maintenance

- Build frontend: `npm run build:desktop` (commit the generated `desktop/desktop.js` and license).
- Tests: `npm run test:browser`, `npm run test:desktop`, and `npm test --prefix home-browser/gateway`.
- Private state: `~/Library/Application Support/aarav-home-desktop/config.json` (0600 in a 0700 directory). It contains the password hash and session secret. Never commit or publish it; keep any backup private.
- The desktop password hash is copied at initial setup. Later browser password changes do not automatically change the desktop password.
- Bundled noVNC is licensed under MPL-2.0; see `desktop/novnc-LICENSE.txt`. Its source is available through the pinned `@novnc/novnc` npm dependency.
