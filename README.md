# Time Machine Timetable

Static GitHub Pages front-end for The Heritage Public School timetable, with Google Sheet sync through a dedicated Google Apps Script backend.

## What This Publishes

- `index.html` is the live GitHub Pages app.
- `.nojekyll` tells GitHub Pages to serve the static app directly.
- `google-apps-script/Code.gs` is the private Google backend.
- `google-apps-script/appsscript.json` is the Apps Script manifest.

## Security Model

- The GitHub Pages website is public to anyone with the URL.
- The Google Sheet stays private in the school Google account.
- Users can view the app from the link.
- Timetable edits, deletes, imports, settings saves, undo/redo, and Google saves require the shared Principal key.
- The Principal key is never stored as plain text. Apps Script stores only a salted SHA-256 hash in script properties.
- The key is kept only in browser memory after unlock, so refresh/new device requires entering it again.

## GitHub Pages Deployment

1. Use the existing public GitHub repository `Theyuvraj/THPS_Time-Machine`.
2. Upload the files in this folder to the repository root.
3. Open repository Settings -> Pages.
4. Set Source to `Deploy from a branch`.
5. Select branch `main` and folder `/ (root)`.
6. Save and wait for the Pages URL.

The site URL will normally look like:

```text
https://Theyuvraj.github.io/THPS_Time-Machine/
```

## Apps Script Deployment

1. Open <https://script.google.com>.
2. Create a new Apps Script project named `Time Machine Timetable Backend`.
3. Replace `Code.gs` with `google-apps-script/Code.gs`.
4. Open Project Settings and enable showing `appsscript.json`, then replace it with `google-apps-script/appsscript.json`.
5. Click Deploy -> New deployment -> Web app.
6. Use:
   - Execute as: `Me`
   - Who has access: `Anyone`
7. Authorize the spreadsheet permission.
8. Copy the Web App URL ending in `/exec`.
9. In the timetable app, open Settings -> Google Sync, paste the Apps Script Web App URL, save settings, then click Force connect.
10. Create the shared Principal key when prompted.
11. Save the current timetable to Google once from the principal device.

## First Live Check

1. Open the GitHub Pages URL on device A.
2. Click Force connect.
3. Enter/create the Principal key and save to Google.
4. Open the same URL on device B.
5. Click Force connect and confirm the same timetable appears.
6. Try a wrong Principal key and confirm edits/save are rejected.
7. Try the correct Principal key and confirm changes can be saved.
