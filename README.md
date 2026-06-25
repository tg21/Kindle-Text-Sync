# Markdown Live Editor Server

A small Node.js server that keeps markdown in backend memory and offers:

- live preview at `/`
- live raw markdown editing at `/edit.html`
- real-time sync between multiple editor sessions
- cursor/selection sync across edit clients
- manual save to the source markdown file on disk

## Setup

1. Run `npm install`
2. Run `npm start`
3. On first startup, answer prompts for the working directory and markdown filename.
4. Config is saved to `.kts_data` in the project directory and reused on subsequent starts.
5. Open `http://localhost:3000/edit.html` to edit
6. Open `http://localhost:3000/` to preview

## Features

- backend memory is the source of truth for preview and editor sessions
- editor pages sync changes instantly through server events
- preview updates are debounced on the server before rerendering
- save button on both preview and editor pages writes the current markdown back to disk

## Configuration

On first startup the server prompts for:

- working directory for markdown files
- markdown file name inside that directory

This information is stored in `.kts_data` inside the project directory and reused on later startups. Existing values are offered as defaults each time the server starts.

You can still override the watched file path at runtime with environment variables:

- `WATCH_FILE` - path to the markdown source file to load at startup and save to
- `PORT` - server port

Example:

```powershell
$env:WATCH_FILE = "D:\\Code\\obsidian\\test-v1\\test.md"
$env:PORT = 3000
npm start
```

## Endpoints

- `GET /` - rendered preview page
- `GET /edit.html` - raw markdown editor page
- `GET /markdown` - current raw markdown from backend memory
- `GET /watch-info` - JSON with current watch file and working directory
- `POST /edit-state` - editor state updates (markdown + selection)
- `POST /save` - persist backend markdown to `WATCH_FILE`

## Notes

- The app no longer waits for the watched markdown file to change before updating the preview.
- The editor page sends edits immediately; the server debounces preview rendering only.


## local development special
 - stop tracking updates to following files `git update-index --skip-worktree .\.kts_data .\index.html`