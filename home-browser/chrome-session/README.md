# Session persistence

The browser is one long-running Chrome process, independent of the website
viewer. Closing `/browser/` disconnects the display stream; reopening it joins
the same desktop and tabs. The `chrome-profile` volume stores the entire profile.

`CHROME_CLI=--restore-last-session` reopens saved regular tabs when Chrome starts
again. The Compose `pre_stop` hook sends `SIGINT` to the primary browser and waits
up to 20 seconds before the desktop shuts down. It leaves renderer processes
running while Chrome saves its session. Use Docker Compose 2.30 or later and
`docker compose stop`/`down` for planned shutdowns; direct `docker stop` and sudden
host shutdowns do not run Compose hooks.

No startup script rewrites Chrome Preferences or clears recovery state. After a
crash or power loss, Chrome may show its Restore prompt. Incognito tabs do not
survive a Chrome restart. Ordinary site cookies remain in the volume, but websites
can expire logins. Reopening a saved tab after a process restart reloads the page
and cannot guarantee recovery of unsaved forms or other in-memory application
state. The profile should be copied only after Chrome has stopped.

The pinned image was tested in an isolated container: its default Docker shutdown
left a crashed-session marker and did not auto-restore a test tab. Sending SIGINT
first recorded a clean exit and restored the tab after a full container restart.

Primary references:

- [Chromium startup preference and restore flag](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/startup/startup_browser_creator.cc)
- [Chromium POSIX shutdown signals](https://github.com/chromium/chromium/blob/main/chrome/browser/chrome_browser_main_posix.cc)
- [Chromium crash-recovery acknowledgment](https://github.com/chromium/chromium/blob/main/chrome/browser/sessions/exit_type_service.cc)
- [Docker Compose lifecycle hooks](https://docs.docker.com/compose/how-tos/lifecycle/)
