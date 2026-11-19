# Discord OAuth2 RPC — Chrome extension ( POC )

A Manifest V3 extension base on [aiko-chan-ai/Discord-OAuth2-RPC](https://github.com/aiko-chan-ai/Discord-OAuth2-RPC). Configure a Discord application, authorize your account, and publish browser activity using templates. 

## Build and install

Use Chrome 120 or newer and a Node.js version supported by Vite 8.

```sh
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder.
3. Right-click the extension's toolbar icon and choose **Open settings side panel**. The setup form displays the callback URL for the installed extension ID.
4. A normal click on the toolbar icon toggles tracking on or off. Tracking starts off; turning it off hides the activity without deleting the OAuth session.

Use `npm run dev` for development. Production builds are preferable when configuring the final redirect URL. An extension's ID can change when loaded from a different location or installed differently; always copy the callback shown by the installed extension.

## Configure Discord

1. Create or open an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the application's **Social SDK** access, following Discord's current eligibility and registration requirements.
3. Under **OAuth2**, enable **Public Client**. This extension uses authorization code flow with PKCE; a client secret is not needed for the intended public-client setup.
4. Copy the callback URL from the side panel and register it exactly as a redirect uri in the Discord portal. The extension does not silently substitute another URL.

5. Enter the application's **Client ID** in the extension and save it. Do not enter a bot token or your Discord account token.
6. Authorize in the Discord tab and let the callback page complete sign-in.
7. Save an activity template and enable tracking. Clear the activity or turn off tracking to hide it without signing out; disconnect to remove the saved OAuth session.

The requested scopes follow the reference's public-client Social SDK example: `openid sdk.social_layer_presence`.

## Browser tracking and templates

Click the toolbar icon to toggle tracking. Use its right-click menu to open settings in the side panel. When enabled, tracking follows the active tab of the focused normal Chrome window. **Hide when Chrome loses focus** is on by default. Turn it off to keep showing the last eligible tab while using another application. Incognito windows and internal browser/extension pages always hide the activity. Refocusing an eligible tab updates the activity.

Text and image fields accept these parameters:

| Parameter | Value |
| --- | --- |
| `{tab_title}` | Active tab title |
| `{tab_favicon}` | Google S2 raster site icon, requested at 128px |
| `{tab_icon_large}` | Icon Horse PNG site icon, requested at 128px |
| `{tab_count}` | Tab count across normal, non-incognito windows |
| `{window_count}` | Normal, non-incognito window count |
| `{window_tab_count}` | Tab count in the focused window |
| `{tab_hostname}` | Active tab hostname |
| `{tab_origin}` | Active tab origin without its path or query |
| `{tab_url}` | Full active tab URL, only when URL sharing is enabled |
| `{browser_elapsed}` | Time since the browser-session baseline |
| `{tab_elapsed}` | Time since the tab was created or first observed |
| `{active_elapsed}` | Time since the current tab became active |

`{tab_favorite_icon}` and `{tab_fravirte_icon}` are accepted aliases for `{tab_favicon}`. Google S2 returns a raster image even when a site's source icon is SVG or ICO. `{tab_icon_large}` uses [Icon Horse](https://icon.horse/) with its 128px PNG endpoint. Requested size does not guarantee a native high-resolution source; providers may return a smaller icon or a placeholder. Local/private hosts are not sent to these services. Missing usable values are empty. Text values update on browser events, not as a second-by-second stopwatch. Unknown parameters remain visible as literal text.

For example, use `Browsing {tab_hostname}` as the activity name and `{tab_title}` as the details. A favicon URL can go in the large image field. Arbitrary HTTPS image URLs use Discord's external-assets endpoint; availability still depends on Discord accepting the image.

Configure up to two Discord link buttons with a label and an HTTP(S) URL. Their fields can use parameters too. A `{tab_url}` button is omitted while full URL sharing is off.

The activity template's start and optional end fields control the timer directly. Leave both blank to hide it. They accept epoch milliseconds, an ISO date/time with an explicit timezone (for example `2026-11-20T12:00:00+07:00`), or one of these exact parameters:

- `{browser_started_at}`
- `{tab_opened_at}`
- `{tab_active_at}`

An end must be after the start. Discord can display a countdown when an end is provided. These timestamp parameters belong in the timestamp fields, not image or link fields.

Chrome does not provide an exact historical creation time for tabs that already existed when tracking started. Session timestamps survive worker suspension, but a new browser session resets them. Extension reloads or installation during an existing session can establish a new baseline.

## Background behavior

The service worker owns token refresh, gateway heartbeats, reconnect attempts, browser observation, and presence updates. Closing the side panel does not intentionally disconnect it. Switching focus away from Chrome hides the activity when **Hide when Chrome loses focus** is enabled. Chrome must remain running with the extension enabled; a service worker is not a separate operating-system daemon. Browser shutdown, extension reloads, sleep, loss of network, and Discord service changes may interrupt presence. Saved connection preferences allow recovery when Chrome wakes the worker.

Chrome's WebSocket service-worker support is described in the [Chrome WebSocket guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).

## Implementation

- `src/ui/`, `src/sidepanel/`: Chakra UI settings, activity templates, tracking controls, and preview.
- `callback.html`, `src/callback/`: OAuth redirect landing page.
- `src/background/`: worker-managed OAuth, storage, and status lifecycle.
- `src/shared/`: typed interface between extension pages and the worker.
- `src/lib/`: native-fetch API client and protocol helpers.
- `manifest.config.ts`: extension permissions and entry points.

The REST client is a new native `fetch` implementation accepting API paths; the reference repository's request client is not imported. Real-time presence uses a separate browser WebSocket connection to `gateway.gaming-sdk.com`, matching the reference's OAuth Social SDK example rather than the normal bot gateway.
