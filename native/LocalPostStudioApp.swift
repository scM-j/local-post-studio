import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var worker: Process?
    private var workerStdin: FileHandle?
    private var serverOrigin: String?
    private var quitting = false
    private var stderrBuffer = ""
    private let stderrLock = NSLock()

    private var resourcesURL: URL {
        Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }

    private var appRootURL: URL {
        let bundled = resourcesURL.appendingPathComponent("app")
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("local_app.py").path) {
            return bundled
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("app")
    }

    private var dataDirURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = support.appendingPathComponent("Local Post Studio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenus()
        setupWindow()
        startBackend()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        stopBackend()
    }

    // MARK: - Native Menu Bar
    private func setupMenus() {
        let mainMenu = NSMenu()

        // App Menu
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: "Local Post Studio")
        appMenu.addItem(withTitle: "关于 Local Post Studio", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "打开数据目录（模型 / 项目）", action: #selector(openDataDirectory), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Local Post Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Local Post Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Edit Menu (enables Cmd+C/V/X/A/Z inside WKWebView)
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        // View Menu
        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        viewMenu.addItem(withTitle: "重新载入界面", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenu.addItem(.separator())
        let fsItem = viewMenu.addItem(withTitle: "切换全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fsItem.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        // Window Menu
        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func openDataDirectory() {
        NSWorkspace.shared.open(dataDirURL)
    }

    @objc private func reloadWebView() {
        webView?.reload()
    }

    // MARK: - Window & WKWebView
    private func setupWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.allowsAirPlayForMediaPlayback = false

        let userContent = WKUserContentController()
        userContent.add(self, name: "localPost")
        let bridgeScript = """
        (() => {
          const pending = new Map();
          let seq = 1;
          window.__localPostResolve = (id, value) => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            entry.resolve(value);
          };
          window.__localPostReject = (id, message) => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            entry.reject(new Error(message || 'Native call failed'));
          };
          const invoke = (action, payload = {}) => new Promise((resolve, reject) => {
            const id = String(seq++);
            pending.set(id, { resolve, reject });
            window.webkit.messageHandlers.localPost.postMessage({ id, action, ...payload });
          });
          window.localPost = {
            isMacDesktop: true,
            chooseOutputDirectory: () => invoke('chooseOutputDirectory'),
            openOutputDirectory: directory => invoke('openOutputDirectory', { directory }),
            saveTextFile: (filename, content) => invoke('saveTextFile', { filename, content }),
            setAppearance: mode => {
              try { window.webkit.messageHandlers.localPost.postMessage({ action: 'setAppearance', mode }); } catch (_) {}
            },
          };
          document.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            const bar = event.target instanceof Element ? event.target.closest('.titlebar') : null;
            if (!bar || event.target.closest('button, input, select, a, [role=button]')) return;
            if (event.detail === 2) {
              window.webkit.messageHandlers.localPost.postMessage({ action: 'zoomWindow' });
            } else {
              window.webkit.messageHandlers.localPost.postMessage({ action: 'dragWindow' });
            }
          });
        })();
        """
        userContent.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = userContent

        let frame = NSRect(x: 0, y: 0, width: 1440, height: 920)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Local Post Studio"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 820, height: 620)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let visualEffect = NSVisualEffectView(frame: window.contentView!.bounds)
        visualEffect.autoresizingMask = [.width, .height]
        visualEffect.blendingMode = .behindWindow
        visualEffect.material = .underWindowBackground
        visualEffect.state = .followsWindowActiveState
        visualEffect.addSubview(webView)

        window.contentView = visualEffect

        // Show clean startup placeholder while Python starts (< 300ms)
        let loadingHTML = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
        :root { color-scheme: light dark; font: 14px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
        body { margin:0; height:100vh; display:grid; place-items:center; background:transparent; color: #8b93a2; }
        .box { display:grid; gap:10px; place-items:center; }
        .mark { width:36px; height:36px; border-radius:9px; display:grid; place-items:center;
                background:linear-gradient(145deg,#0a84ff,#5e5ce6); color:#fff; font-size:18px; }
        </style></head>
        <body><div class="box"><div class="mark">◈</div><div>正在启动本地媒体引擎…</div></div></body></html>
        """
        webView.loadHTMLString(loadingHTML, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Python Backend Process
    private func resolvePythonPath() -> String {
        var candidates: [String] = []
        if let envPy = ProcessInfo.processInfo.environment["LOCAL_POST_PYTHON"], !envPy.isEmpty {
            candidates.append(envPy)
        }
        candidates.append(resourcesURL.appendingPathComponent("venv/bin/python3").path)
        candidates.append(appRootURL.deletingLastPathComponent().appendingPathComponent(".venv/bin/python3").path)
        candidates.append("/Library/Frameworks/Python.framework/Versions/3.14/bin/python3")
        candidates.append("/Library/Frameworks/Python.framework/Versions/3.13/bin/python3")
        candidates.append("/Library/Frameworks/Python.framework/Versions/3.12/bin/python3")
        candidates.append("/opt/homebrew/bin/python3")
        candidates.append("/usr/local/bin/python3")
        candidates.append("/usr/bin/python3")

        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return "/usr/bin/env"
    }

    private func startBackend() {
        let pythonPath = resolvePythonPath()
        let scriptPath = appRootURL.appendingPathComponent("local_app.py").path
        guard FileManager.default.fileExists(atPath: scriptPath) else {
            showFatalError("找不到本地服务脚本：\(scriptPath)")
            return
        }

        let proc = Process()
        if pythonPath == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["python3", "-I", "-B", "-u", "-X", "utf8", scriptPath, "--no-browser", "--managed"]
        } else {
            proc.executableURL = URL(fileURLWithPath: pythonPath)
            proc.arguments = ["-I", "-B", "-u", "-X", "utf8", scriptPath, "--no-browser", "--managed"]
        }
        proc.currentDirectoryURL = appRootURL

        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "PYTHONHOME")
        env.removeValue(forKey: "PYTHONPATH")
        env["PYTHONNOUSERSITE"] = "1"
        env["LOCAL_POST_DATA_DIR"] = dataDirURL.path
        let pydeps = resourcesURL.appendingPathComponent("pydeps")
        if FileManager.default.fileExists(atPath: pydeps.path) {
            env["LOCAL_POST_PYDEPS"] = pydeps.path
        }
        proc.environment = env

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe
        self.workerStdin = stdinPipe.fileHandleForWriting

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            self?.stderrLock.lock()
            self?.stderrBuffer = String(((self?.stderrBuffer ?? "") + chunk).suffix(8000))
            self?.stderrLock.unlock()
        }

        var stdoutAccum = ""
        var launched = false
        let timeoutWork = DispatchWorkItem { [weak self] in
            guard let self = self, !launched, !self.quitting else { return }
            self.showFatalError("本地媒体服务启动超时。\n\n\(self.readStderr())")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeoutWork)

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            stdoutAccum += chunk
            guard !launched, let newlineRange = stdoutAccum.range(of: "\n") else { return }
            let address = String(stdoutAccum[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            launched = true
            handle.readabilityHandler = nil
            DispatchQueue.main.async {
                timeoutWork.cancel()
                self?.loadBackendURL(address)
            }
        }

        proc.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.showFatalError("本地媒体服务已意外退出（代码 \(finished.terminationStatus)）。\n\n\(self.readStderr())")
            }
        }

        do {
            try proc.run()
            self.worker = proc
        } catch {
            timeoutWork.cancel()
            showFatalError("无法启动本地媒体服务：\(error.localizedDescription)")
        }
    }

    private func readStderr() -> String {
        stderrLock.lock()
        defer { stderrLock.unlock() }
        return stderrBuffer
    }

    private func loadBackendURL(_ address: String) {
        guard let url = URL(string: address), url.scheme == "http", url.host == "127.0.0.1" else {
            showFatalError("本地服务返回了无效地址：\(address)")
            return
        }
        serverOrigin = "\(url.scheme!)://\(url.host!):\(url.port ?? 80)"
        webView.load(URLRequest(url: url))
    }

    private func stopBackend() {
        if let stdin = workerStdin {
            try? stdin.close()
            workerStdin = nil
        }
        guard let proc = worker, proc.isRunning else { return }
        proc.terminate()
        let deadline = Date().addingTimeInterval(2.5)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    private func showFatalError(_ message: String) {
        if quitting { return }
        quitting = true
        stopBackend()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Local Post Studio"
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - JS Bridge Handler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        let id = body["id"] as? String

        switch action {
        case "dragWindow":
            if let event = NSApp.currentEvent {
                window.performDrag(with: event)
            }
        case "zoomWindow":
            window.performZoom(nil)
        case "setAppearance":
            if let mode = body["mode"] as? String {
                switch mode {
                case "dark": window.appearance = NSAppearance(named: .darkAqua)
                case "light": window.appearance = NSAppearance(named: .aqua)
                default: window.appearance = nil
                }
            }
        case "chooseOutputDirectory":
            guard let id = id else { return }
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "选择"
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let path = panel.url?.path {
                    self?.resolveJS(id: id, jsonValue: self?.jsonString(path) ?? "null")
                } else {
                    self?.resolveJS(id: id, jsonValue: "null")
                }
            }
        case "openOutputDirectory":
            guard let id = id else { return }
            guard let directory = body["directory"] as? String, directory.hasPrefix("/") else {
                resolveJS(id: id, jsonValue: jsonString("无效路径"))
                return
            }
            let url = URL(fileURLWithPath: directory)
            if FileManager.default.fileExists(atPath: directory) {
                NSWorkspace.shared.open(url)
                resolveJS(id: id, jsonValue: jsonString(""))
            } else {
                resolveJS(id: id, jsonValue: jsonString("目录不存在"))
            }
        case "saveTextFile":
            guard let id = id,
                  let filename = body["filename"] as? String,
                  let content = body["content"] as? String else {
                if let id = id { resolveJS(id: id, jsonValue: "false") }
                return
            }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = filename
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let url = panel.url {
                    do {
                        try content.write(to: url, atomically: true, encoding: .utf8)
                        self?.resolveJS(id: id, jsonValue: "true")
                    } catch {
                        self?.rejectJS(id: id, message: error.localizedDescription)
                    }
                } else {
                    self?.resolveJS(id: id, jsonValue: "false")
                }
            }
        default:
            break
        }
    }

    private func jsonString(_ string: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [string]),
              let encoded = String(data: data, encoding: .utf8) else { return "null" }
        return String(encoded.dropFirst().dropLast())
    }

    private func resolveJS(id: String, jsonValue: String) {
        webView.evaluateJavaScript("window.__localPostResolve(\(jsonString(id)), \(jsonValue));", completionHandler: nil)
    }

    private func rejectJS(id: String, message: String) {
        webView.evaluateJavaScript("window.__localPostReject(\(jsonString(id)), \(jsonString(message)));", completionHandler: nil)
    }

    // MARK: - WKUIDelegate (File Picker & Native Confirm/Alert)
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Local Post Studio"
        alert.informativeText = message
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Local Post Studio"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in
            completionHandler()
        }
    }

    // MARK: - WKNavigationDelegate (Localhost origin lock)
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "about" || url.scheme == "blob" {
            decisionHandler(.allow)
            return
        }
        if let origin = serverOrigin,
           let host = url.host,
           "\(url.scheme ?? "")://\(host):\(url.port ?? 80)" == origin {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
