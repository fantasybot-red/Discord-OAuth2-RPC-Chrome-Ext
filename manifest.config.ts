import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest({
  manifest_version: 3,
  name: "Discord OAuth2 RPC",
  description: pkg.description,
  version: pkg.version,
  // chrome.alarms 30s minimum period (Chrome 120) and WebSocket traffic
  // keeping the service worker alive (Chrome 116) are both relied upon.
  minimum_chrome_version: '120',
  icons: {
    48: 'public/logo.png',
  },
  // No popup: clicking the icon opens the side panel.
  action: {
    default_icon: {
      48: 'public/logo.png',
    },
    default_title: 'Discord presence: open side panel',
  },
  // `tabs` provides tab title/URL/favicon to the background worker only
  // (needed for {tab_title} etc.); it adds no host access.
  permissions: ['sidePanel', 'storage', 'alarms', 'tabs'],
  // Only the Discord REST/OAuth host. Match patterns cannot express wss://;
  // WebSocket connections to wss://gateway.gaming-sdk.com are not governed by
  // host permissions, and the default MV3 extension-page CSP has no connect-src
  // restriction, so no extra CSP is declared.
  host_permissions: ['https://discord.com/*'],
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // The OAuth redirect is a navigation initiated by a web page (discord.com)
  // to chrome-extension://<id>/callback.html. Chrome blocks web-origin ->
  // extension navigations unless the target is web accessible, so callback.html
  // is exposed narrowly to discord.com only. use_dynamic_url stays false so the
  // extension ID (and therefore the registered redirect URI) is stable.
  web_accessible_resources: [
    {
      resources: ['callback.html'],
      matches: ['https://discord.com/*'],
      use_dynamic_url: false,
    },
  ],
})
