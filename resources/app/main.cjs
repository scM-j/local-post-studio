const { app, BrowserWindow, Menu, dialog, session, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function resolveRoot() {
  if (app.isPackaged) {
    if (existsSync(path.join(process.resourcesPath, 'local_app.py'))) return process.resourcesPath;
    if (existsSync(path.join(process.resourcesPath, 'app', 'local_app.py'))) return path.join(process.resourcesPath, 'app');
    return path.dirname(process.execPath);
  }
  const candidate = path.resolve(__dirname, '..', '..');
  if (existsSync(path.join(candidate, 'local_app.py'))) return candidate;
  return path.dirname(process.execPath);
}

function resolvePython(root) {
  const candidates = isWin
    ? [path.join(root, 'runtime', 'python.exe'), 'python']
    : [
        process.env.LOCAL_POST_PYTHON,
        path.join(root, 'runtime', 'bin', 'python3'),
        path.join(root, '..', '.venv', 'bin', 'python3'),
        '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/usr/bin/python3',
        'python3',
      ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep) || existsSync(candidate)) return candidate;
  }
  return isWin ? 'python' : 'python3';
}

const root = resolveRoot();
const name = existsSync(path.join(root, 'release-channel.txt')) || app.isPackaged
  ? 'Local Post Studio'
  : 'Local Post Studio Development';
app.setName(name);
const userDataDir = path.join(app.getPath('appData'), 'Local Post Studio');
app.setPath('userData', userDataDir);
if (!app.requestSingleInstanceLock()) app.exit(0);

let worker;
let quitting = false;
let errorText = '';

function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  try { worker.stdin.end(); } catch (_) {}
  const processToStop = worker;
  setTimeout(() => {
    if (processToStop.exitCode === null) processToStop.kill();
  }, 5000).unref();
}

function fail(message) {
  if (quitting) return;
  quitting = true;
  stopWorker();
  dialog.showErrorBox('Local Post Studio', message);
  app.quit();
}

function setupMacMenu() {
  if (!isMac) return;
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  setupMacMenu();
  ipcMain.handle('choose-output-directory', async event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('open-output-directory', async (event, directory) => {
    if (!BrowserWindow.fromWebContents(event.sender) || typeof directory !== 'string' || !path.isAbsolute(directory)) return '无效路径';
    return shell.openPath(directory);
  });
  ipcMain.handle('save-text-file', async (event, filename, content) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof filename !== 'string' || typeof content !== 'string') return false;
    const result = await dialog.showSaveDialog(win, { defaultPath: filename });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, content, 'utf8');
    return true;
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const env = { ...process.env, PYTHONNOUSERSITE: '1', LOCAL_POST_DATA_DIR: userDataDir };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  const pythonBin = resolvePython(root);
  worker = spawn(
    pythonBin,
    ['-I', '-B', '-u', '-X', 'utf8', path.join(root, 'local_app.py'), '--no-browser', '--managed'],
    { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-8000); });
  worker.once('error', error => fail('无法启动本地服务：' + error.message));
  worker.once('exit', code => {
    if (!quitting) fail('本地服务已退出（代码 ' + code + '）。\n' + errorText);
  });

  let output = '';
  const timeout = setTimeout(() => fail('本地服务启动超时。'), 20000);
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', chunk => {
    output += chunk;
    if (!output.includes('\n')) return;
    const address = output.split(/\r?\n/)[0].trim();
    worker.stdout.removeAllListeners('data');
    worker.stdout.resume();
    clearTimeout(timeout);
    let url;
    try { url = new URL(address); } catch (_) { fail('本地服务返回了无效地址。'); return; }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      fail('本地服务地址无效。');
      return;
    }
    const win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 820,
      minHeight: 620,
      title: name,
      backgroundColor: '#121316',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'under-window' } : {}),
      ...(!isMac && existsSync(path.join(root, 'local-post-studio.ico')) ? { icon: path.join(root, 'local-post-studio.ico') } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, destination) => {
      if (new URL(destination).origin !== url.origin) event.preventDefault();
    });
    win.loadURL(address).catch(error => fail('界面加载失败：' + error.message));
  });
});

app.on('window-all-closed', () => { quitting = true; stopWorker(); app.quit(); });
app.on('before-quit', () => { quitting = true; stopWorker(); });
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
