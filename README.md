# GroupMe Chat Exporter

A userscript that exports a full GroupMe group chat from the web app to **JSON**, **CSV**, or a self-contained **offline HTML** viewer, with optional media archiving into a ZIP.

Everything runs locally in your browser. Nothing is sent to any third-party service.

## Features

- **Three formats:** JSON (full raw data plus a resolved user directory), CSV (spreadsheet-friendly, Excel-safe IDs), and a searchable dark-theme HTML archive.
- **Media archiving:** downloads avatars and image/file attachments into a ZIP, with the HTML/JSON rewritten to point at the local copies. Videos are opt-in because they're large.
- **No size limit on the ZIP:** on Chromium browsers the archive streams straight to disk as it downloads (ZIP64), so memory stays flat even for multi-GB exports.
- **GroupMe emoji packs:** the "�" placeholders are resolved to the real emoji images, embedded in the HTML and saved as PNGs under `emoji/` in the ZIP. In CSV they appear as `[emoji p2#50: label]`.
- **Readable reactions:** reactions and likes show display names instead of raw user IDs (IDs remain in the hover tooltip).
- **Forensic metadata:** per-message IDs, timestamps (Unix, UTC, local), edit times, replies, locations, pins, and a participant/alias directory with message counts.
- **Fast:** parallel media downloads, rate-limit retry, and a minimal UI footprint.

## Install

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Edge, Firefox, etc).
2. Click the button
[![Install](https://img.shields.io/badge/Install%20from-Greasy%20Fork-orange?style=for-the-badge)](https://greasyfork.org/en/scripts/606520-groupme-chat-exporter)  

Or manually install it:
1. Open `groupme-exporter.user.js` in this repo and click **Raw** and copy the code
2. Visit [web.groupme.com](https://web.groupme.com/) and log in.
3. Open the userscript extention, click the plus button.
4. Paste the code into the editor and install

## Usage

1. Open the chat you want to export. A panel appears in the bottom-right corner and shows the detected **Group ID** (you can also paste one manually).
2. Optionally tick **Download attachments & ZIP** (and **Include videos** if you want them).
3. Click **JSON**, **CSV**, or **HTML**.
4. If you chose ZIP, pick a save location when prompted, then wait for the status to read "Done!".

### Output

Without ZIP, you get a single file. With ZIP:

```
<group>_<id>_<timestamp>.zip
├── <group>_<id>_<timestamp>.html | .json | .csv
├── <group>_<id>_<timestamp>_roster.csv
├── avatars/
├── attachments/
├── emoji/
└── _failed_downloads.txt   (only if some downloads failed)
```

To view an HTML export with images, unzip it first and open the HTML file from inside the extracted folder (it uses relative paths).

## Browser support

| Browser | Export | ZIP streaming to disk |
|---|---|---|
| Chrome / Edge / other Chromium | Yes | Yes (any size) |
| Firefox / Safari | Yes | No. Falls back to building the ZIP in RAM, so keep exports modest |

## Privacy and security

- The script reads your GroupMe `access_token` from the page's storage so it can call the same API the web app uses.
- The token is sent **only** to GroupMe's own hosts (`*.groupme.com`). It is never sent to other domains.
- Media is fetched directly from GroupMe's CDN to your machine. No analytics, no external servers.
- Treat exported files as sensitive. They contain message content, user IDs, and avatars.

## Notes and limitations

- The "client" column (iOS/Android/Web) is **inferred** from the format of each message's `source_guid`. It's a heuristic, not a guarantee.
- Emoji resolution relies on GroupMe's public emoji pack list. If a pack can't be fetched, the emoji falls back to a text label like `[emoji p2#50]`. Check the browser console for `[GM OSINT]` warnings.
- Single attachments larger than 4 GB can't be stored (not a realistic GroupMe case).
- This relies on GroupMe's unofficial web endpoints, which can change without notice.

## Responsible use

Only export chats you are a member of and have a legitimate reason to archive. Respect other participants' privacy and any applicable laws and platform terms. This project is not affiliated with or endorsed by GroupMe or Microsoft.

## License

MIT
