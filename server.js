const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const chokidar = require('chokidar');
const MarkdownIt = require('markdown-it');

const PROJECT_DIR = __dirname;
const CONFIG_FILE = path.join(PROJECT_DIR, '.kts_data');
const PORT = Number(process.env.PORT) || 3000;
const DEBOUNCE_MS = 50;

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
let previewClients = [];
let editorClients = [];
let markdownContent = '';
let lastMarkdownHash = null;
let renderTimer = null;
let latestRenderedHtml = '';
let latestPageHtml = '';
let latestSelection = { start: 0, end: 0 };
let WORK_DIR = '';
let WATCH_FILE = process.env.WATCH_FILE || '';


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createPage(bodyHtml, watchedFile) {
  const fileInfo = watchedFile ? `<div class="preview-file-info">Previewing: ${escapeHtml(watchedFile)}</div>` : '';
  return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Markdown Preview</title>\n  <style>body{font-family:system-ui, sans-serif;line-height:1.6;margin:0;padding:1rem;max-width:50rem;min-width:320px;}img{max-width:100%;height:auto;}pre{white-space:pre-wrap;word-break:break-word;}code{font-family:Menlo,Monaco,Consolas,monospace;background:#f4f4f4;padding:0.2rem 0.35rem;border-radius:4px;}a{color:#0066cc;}blockquote{color:#444;border-left:4px solid #ddd;padding-left:1rem;margin-left:0;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:0.5rem;text-align:left;}@media (max-width:640px){body{padding:0.75rem;}}.preview-file-info{font-size:0.9rem;color:#475569;margin-bottom:1rem;} .save-floating{position:fixed;right:1rem;bottom:1rem;display:flex;flex-direction:column;align-items:flex-end;gap:0.4rem;z-index:1000;}button#save-button{background:#0f172a;color:#fff;border:none;padding:0.8rem 1rem;border-radius:999px;cursor:pointer;box-shadow:0 10px 25px rgba(15,23,42,0.2);}button#save-button:hover{background:#111827;}#save-status{font-size:0.85rem;color:#334155;background:rgba(255,255,255,0.9);padding:0.45rem 0.75rem;border-radius:0.75rem;box-shadow:0 10px 25px rgba(15,23,42,0.08);}</style>\n</head>\n<body>\n  <main>\n    ${fileInfo}\n    ${bodyHtml}\n  </main>\n  <div class="save-floating">\n    <div id="save-status"></div>\n    <button id="save-button">Save to disk</button>\n  </div>\n  <script>\n    const source = new EventSource('/events');\n    source.addEventListener('update', (event) => {\n      const main = document.querySelector('main');\n      if (main) {\n        const fileInfoEl = main.querySelector('.preview-file-info');\n        main.innerHTML = event.data;\n        if (fileInfoEl) {\n          main.insertBefore(fileInfoEl, main.firstChild);\n        }\n      }\n    });\n    source.addEventListener('error', () => source.close());\n    const saveButton = document.getElementById('save-button');\n    const saveStatus = document.getElementById('save-status');\n    function setSaveStatus(text) { if (saveStatus) saveStatus.textContent = text; }\n    if (saveButton) {\n      saveButton.addEventListener('click', () => {\n        setSaveStatus('Saving...');\n        fetch('/save', { method: 'POST' })\n          .then((res) => { if (!res.ok) throw new Error('Save failed'); setSaveStatus('Saved to disk'); setTimeout(() => setSaveStatus(''), 1500); })\n          .catch(() => setSaveStatus('Save failed'));\n      });\n    }\n  </script>\n</body>\n</html>`;
}

function writeOutput(html) {
  latestPageHtml = html;
}

function hashString(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function prompt(question, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function isSubPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizePath(p) {
  return path.resolve(p.trim());
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function configureWatchFile() {
  const config = loadConfig();
  let workDir = config.workDir || PROJECT_DIR;
  let fileName = config.fileName || 'test.md';

  while (true) {
    const dirAnswer = await prompt('Enter a working directory for markdown files', workDir);
    const resolvedDir = normalizePath(dirAnswer || PROJECT_DIR);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      console.log(`Directory does not exist: ${resolvedDir}`);
      continue;
    }
    workDir = resolvedDir;
    break;
  }

  while (true) {
    const fileAnswer = await prompt('Enter the markdown file name in that directory', fileName);
    const relativeFile = fileAnswer || fileName;
    const resolvedPath = normalizePath(path.join(workDir, relativeFile));
    if (!isSubPath(workDir, resolvedPath) && path.resolve(relativeFile) !== resolvedPath) {
      console.log('Please enter a file name relative to the chosen working directory.');
      continue;
    }
    fileName = path.relative(workDir, resolvedPath);

    const watchPath = path.join(workDir, fileName);
    if (!fs.existsSync(watchPath)) {
      const createAnswer = await prompt(`File does not exist. Create ${watchPath}?`, 'yes');
      if (createAnswer.toLowerCase().startsWith('y')) {
        fs.writeFileSync(watchPath, '', 'utf8');
        console.log(`Created file: ${watchPath}`);
        break;
      }
      continue;
    }
    break;
  }

  if (config.workDir !== workDir || config.fileName !== fileName) {
    config.workDir = workDir;
    config.fileName = fileName;
    saveConfig(config);
  }

  WORK_DIR = workDir;
  WATCH_FILE = path.join(WORK_DIR, fileName);
}

function renderMarkdown() {
  try {
    const currentHash = hashString(markdownContent);
    if (currentHash === lastMarkdownHash) {
      return;
    }

    lastMarkdownHash = currentHash;
    latestRenderedHtml = md.render(markdownContent);
    writeOutput(createPage(latestRenderedHtml, WATCH_FILE));
    broadcastPreview(latestRenderedHtml);
  } catch (error) {
    const message = `<p><strong>Error rendering markdown:</strong></p><pre>${String(error).replace(/</g, '&lt;')}</pre>`;
    latestRenderedHtml = message;
    writeOutput(createPage(message, WATCH_FILE));
    console.error('Render error:', error);
  }
}

function formatSseEvent(event, data) {
  return `event: ${event}\n${data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;
}

function broadcastPreview(html) {
  const message = formatSseEvent('update', html);
  previewClients = previewClients.filter((client) => {
    try {
      client.write(message);
      return true;
    } catch (error) {
      return false;
    }
  });
}

function broadcastMarkdown() {
  const message = formatSseEvent('markdown', markdownContent);
  editorClients = editorClients.filter((client) => {
    try {
      client.res.write(message);
      return true;
    } catch (error) {
      return false;
    }
  });
}

function broadcastEditState(state, originId) {
  const message = formatSseEvent('edit-state', JSON.stringify(state));
  editorClients = editorClients.filter((client) => {
    if (client.id === originId) {
      return true;
    }
    try {
      client.res.write(message);
      return true;
    } catch (error) {
      return false;
    }
  });
}

function serveFile(filePath, res) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

function scheduleRender() {
  if (renderTimer) {
    clearTimeout(renderTimer);
  }
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderMarkdown();
    broadcastMarkdown();
  }, DEBOUNCE_MS);
}

function loadMarkdownFromFile() {
  try {
    markdownContent = fs.readFileSync(WATCH_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to read markdown source:', error);
    }
    markdownContent = markdownContent || '';
  }
}

function handleEditStatePost(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      if (typeof payload.markdown === 'string') {
        markdownContent = payload.markdown;
      }
      if (typeof payload.selectionStart === 'number' && typeof payload.selectionEnd === 'number') {
        latestSelection = {
          start: payload.selectionStart,
          end: payload.selectionEnd,
        };
      }
      const state = {
        markdown: markdownContent,
        selectionStart: latestSelection.start,
        selectionEnd: latestSelection.end,
        originId: payload.clientId || null,
      };
      res.writeHead(204);
      res.end();
      scheduleRender();
      broadcastEditState(state, payload.clientId);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid JSON');
    }
  });
}

function handleSavePost(req, res) {
  fs.writeFile(WATCH_FILE, markdownContent, 'utf8', (error) => {
    if (error) {
      console.error('Save failed:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unable to save file');
      return;
    }
    res.writeHead(204);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 10000\n\n');
    previewClients.push(res);
    if (latestRenderedHtml) {
      res.write(formatSseEvent('update', latestRenderedHtml));
    }
    req.on('close', () => {
      previewClients = previewClients.filter((client) => client !== res);
    });
    return;
  }

  if (url.pathname === '/edit-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 10000\n\n');
    const clientId = crypto.randomBytes(8).toString('hex');
    editorClients.push({ id: clientId, res });
    res.write(formatSseEvent('edit-state', JSON.stringify({
      markdown: markdownContent,
      selectionStart: latestSelection.start,
      selectionEnd: latestSelection.end,
      originId: null,
    })));
    req.on('close', () => {
      editorClients = editorClients.filter((client) => client.id !== clientId);
    });
    return;
  }

  if (url.pathname === '/save' && req.method === 'POST') {
    handleSavePost(req, res);
    return;
  }

  if (url.pathname === '/watch-info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      workDir: WORK_DIR,
      fileName: path.relative(WORK_DIR, WATCH_FILE),
      watchFile: WATCH_FILE,
    }));
    return;
  }

  if (url.pathname === '/markdown') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(markdownContent);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (url.pathname === '/edit-state' && req.method === 'POST') {
    handleEditStatePost(req, res);
    return;
  }

  if (url.pathname === '/edit' || url.pathname === '/edit.html') {
    serveFile(path.join(__dirname, 'edit.html'), res);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (latestPageHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(latestPageHtml);
      return;
    }
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Preview not ready');
    return;
  }

  const localPath = path.join(__dirname, url.pathname);
  if (localPath.startsWith(__dirname)) {
    fs.stat(localPath, (err, stats) => {
      if (!err && stats.isFile()) {
        if (url.pathname.endsWith('.css')) {
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        } else if (url.pathname.endsWith('.js')) {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        }
        fs.createReadStream(localPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

async function initServer() {
  await configureWatchFile();

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`Watching markdown file: ${WATCH_FILE}`);
    loadMarkdownFromFile();
    renderMarkdown();
  });

  const watcher = chokidar.watch(WATCH_FILE, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 100,
    },
  });

  watcher.on('add', () => {
    loadMarkdownFromFile();
    scheduleRender();
  });
  watcher.on('change', () => {
    loadMarkdownFromFile();
    scheduleRender();
  });
  watcher.on('unlink', () => {
    markdownContent = '';
    scheduleRender();
  });
  watcher.on('error', (error) => console.error('Watcher error:', error));
}

initServer().catch((error) => {
  console.error('Failed to initialize server:', error);
  process.exit(1);
});
