import { readFileSync } from 'node:fs';
import { createBrowserRelay } from '../lib/browser-relay.mjs';

const { discoveryUrl } = JSON.parse(readFileSync(new URL('../browser/connection.json', import.meta.url), 'utf8'));
export const maxDuration = 300;
export default createBrowserRelay({
  discoveryUrl,
  basePath: '/desktop/session',
  sessionCookie: '__Host-home_desktop',
  relayEndpoint: '/api/desktop-relay',
  relayPathQuery: '__desktop_relay_path',
}).server;
