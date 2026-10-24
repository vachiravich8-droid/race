# Connect TikTok LIVE to your Roblox race

Roblox can't read TikTok by itself. This small server reads your LIVE
comments, and the game asks it for new ones every second.

## 1. Put the bridge online (free, Render.com)

1. Make a GitHub account, create a new repository, and upload
   `server.js` and `package.json`.
2. Go to https://render.com, sign in with GitHub, click **New → Web Service**,
   pick your repository.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
4. Under **Environment**, add:
   - `BRIDGE_KEY` = a secret word only you know, e.g. `judy-race-8842`
5. Click **Create**. When it's done you get a link like
   `https://judy-bridge.onrender.com`. Open it — you should see
   `{"ok":true,...}`.

(Free Render servers sleep when unused. The first Connect can take ~1 minute
to wake it up.)

## 2. Tell the game where the bridge is

In Roblox Studio open **ServerScriptService → RaceConfig** and set:

```lua
BRIDGE_URL = "https://judy-bridge.onrender.com",
BRIDGE_KEY = "judy-race-8842",   -- same word as on Render
```

## 3. Publish the game

**File → Publish to Roblox**. Then in **Game Settings → Security** turn on
**Allow HTTP Requests** and **Enable Studio Access to API Services**
(the second one makes TOP WORLD save wins).

## 4. Go LIVE

1. Start your TikTok LIVE.
2. Play the game, type your TikTok name in the LIVE panel
   (e.g. `@yourname`) and press **Connect LIVE**.
3. Viewers comment to join. If the comment is a Roblox username
   (e.g. `Builderman`), their racer wears that avatar.
4. AUTO mode starts a race 30 s after 2+ people join. MANUAL waits for
   **START RACE**.

## Settings you can change (RaceConfig)

- `JOIN_KEYWORD` — set to `"join"` so only comments with "join" enter.
- `AUTO_LOBBY_SECONDS`, `AUTO_MIN_RACERS`, `MAX_RACERS`.
- `HOST_USER_IDS` — Roblox user IDs of people allowed to press the buttons.

## If it doesn't connect

- Panel says **"is not LIVE"** → your TikTok LIVE isn't running yet.
- Panel says **Wrong BRIDGE_KEY** → the key in RaceConfig and Render differ.
- Panel shows an error about signing or rate limits → get a free key at
  https://www.eulerstream.com and add it on Render as `SIGN_API_KEY`.

## Web control panel (new)

The bridge now also hosts a website for running the race from a phone or PC.

1. Upload the new files to the same GitHub repository: `server.js` (replaces the old one),
   `panel.html`, `overlay.html`. Render redeploys by itself after a minute or two.
2. Open `https://<your-bridge>.onrender.com/panel` and type your `BRIDGE_KEY`.
   The key is remembered on that device; press **ออก** to sign out.
3. The game has to be running (published game, or Play in Studio) with the **WebLink** script
   in ServerScriptService. The top bar turns green ("เกม: ออนไลน์") when it's linked.

What you can do there: start / end races, +10 test racers, add a racer by name, announce,
test gifts (to a named racer or a random one), events, map / laps / mode / capacity / ghost,
connect TikTok LIVE, type the same `:commands` as in-game chat, and watch the live
standings plus TikTok comments and gifts. With more than one server online, pick which one
the buttons control (or all of them) in the 🎯 menu.

### Overlay for the LIVE

The panel's **Overlay** card has a link like `https://<your-bridge>.onrender.com/overlay?v=...`.
Add it as a **Link / Browser source** in TikTok LIVE Studio or OBS (420 × 640). It shows the
live standings on a transparent background. That link can only *view*, it can't send commands,
so it's safe to paste into streaming software. (Changing `BRIDGE_KEY` changes the link too.)

Keep `BRIDGE_KEY` secret: anyone who has it can control the race from the panel.
