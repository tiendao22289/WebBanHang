import UIKit
import WebKit

/// Full-screen web view showing the kiosk page (/chamcong). The page talks to the app through
/// `window.webkit.messageHandlers.kiosk.postMessage({type, ...})`: speak, wake, busy.
/// Nút ☰ ở góc: chủ quán đăng nhập (số điện thoại + PIN admin) để tạm dừng / chạy lại máy quầy,
/// chọn thời gian tự khoá màn hình, tải lại trang.
final class KioskViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }

    private let kioskURL: URL
    private var webView: WKWebView!
    private let speaker = Speaker()
    private let offline = UILabel()
    private let menuButton = UIButton(type: .system)
    private let pausedCover = UIView()
    private var reloadWork: DispatchWorkItem?

    init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "KioskURL") as? String
        kioskURL = configured.flatMap(URL.init(string:)) ?? URL(string: "https://ocbaokhang.online/chamcong")!
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the kiosk cookie across launches
        // Keep Safari's "Mobile/…" token so the page still sees a phone, then name the app.
        config.applicationNameForUserAgent = "Mobile/15E148 ChamCongApp/\(Self.version)"
        config.allowsInlineMediaPlayback = true
        config.dataDetectorTypes = []
        let content = WKUserContentController()
        // face: false — máy quầy chỉ hiện mã QR (chủ quán đã bỏ so khuôn mặt).
        let bootstrap = "window.ChamCongApp = Object.assign(window.ChamCongApp || {}, { version: \(Self.json(Self.version)), face: false });"
        content.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(KioskMessages(self), name: "kiosk")
        config.userContentController = content

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1)
        view = webView

        offline.text = "Mất mạng, đang thử lại…"
        offline.textColor = .white
        offline.font = .boldSystemFont(ofSize: 22)
        offline.textAlignment = .center
        offline.numberOfLines = 0
        offline.isHidden = true
        offline.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(offline)

        // Màn "đang tạm dừng": che mã QR, chủ quán bấm ☰ để chạy lại.
        pausedCover.backgroundColor = UIColor(red: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 1)
        pausedCover.translatesAutoresizingMaskIntoConstraints = false
        pausedCover.isHidden = true
        let pausedText = UILabel()
        pausedText.text = "⏸ Máy quầy đang tạm dừng\n\nChủ quán bấm ☰ ở góc trên để chạy lại."
        pausedText.textColor = .white
        pausedText.font = .boldSystemFont(ofSize: 22)
        pausedText.textAlignment = .center
        pausedText.numberOfLines = 0
        pausedText.translatesAutoresizingMaskIntoConstraints = false
        pausedCover.addSubview(pausedText)
        view.addSubview(pausedCover)

        menuButton.setTitle("☰", for: .normal)
        menuButton.titleLabel?.font = .systemFont(ofSize: 26, weight: .bold)
        menuButton.tintColor = UIColor.white.withAlphaComponent(0.7)
        menuButton.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        menuButton.layer.cornerRadius = 10
        menuButton.accessibilityLabel = "Cài đặt máy quầy (chủ quán)"
        menuButton.translatesAutoresizingMaskIntoConstraints = false
        menuButton.addTarget(self, action: #selector(menuTapped), for: .touchUpInside)
        view.addSubview(menuButton)

        NSLayoutConstraint.activate([
            offline.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            offline.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            offline.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            pausedCover.topAnchor.constraint(equalTo: view.topAnchor),
            pausedCover.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            pausedCover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pausedCover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pausedText.centerYAnchor.constraint(equalTo: pausedCover.centerYAnchor),
            pausedText.leadingAnchor.constraint(equalTo: pausedCover.leadingAnchor, constant: 24),
            pausedText.trailingAnchor.constraint(equalTo: pausedCover.trailingAnchor, constant: -24),
            menuButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            menuButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            menuButton.widthAnchor.constraint(equalToConstant: 48),
            menuButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        pausedCover.isHidden = !AutoLock.shared.paused
        load()
    }

    /// Vừa mở khoá màn hình / mở lại app: trang lấy mã mới ngay.
    func pageWoke() {
        webView?.evaluateJavaScript("window.ChamCongApp && window.ChamCongApp.onWake && window.ChamCongApp.onWake()", completionHandler: nil)
    }

    private func load() {
        reloadWork?.cancel()
        webView.load(URLRequest(url: kioskURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    private func scheduleReload(after seconds: TimeInterval) {
        reloadWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.load() }
        reloadWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // MARK: Messages from the page

    func handle(_ message: WKScriptMessage) {
        // Only the kiosk page itself (main frame, our site) may drive the app.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.host == kioskURL.host, origin.protocol == kioskURL.scheme,
              let msg = message.body as? [String: Any], let type = msg["type"] as? String else { return }
        switch type {
        case "speak":
            if let text = msg["text"] as? String, !AutoLock.shared.paused { speaker.speak(text) }
        case "wake":
            AutoLock.shared.poke()
        case "busy":
            AutoLock.shared.busy = (msg["on"] as? Bool) ?? false
        default:
            break
        }
    }

    static func json(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: s, options: .fragmentsAllowed), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return text
    }

    // MARK: ☰ Chủ quán

    @objc private func menuTapped() {
        let alert = UIAlertController(title: "Chủ quán đăng nhập", message: "Nhập số điện thoại và mã PIN admin để vào cài đặt máy quầy.", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "Số điện thoại admin"
            field.keyboardType = .phonePad
            field.textContentType = .telephoneNumber
        }
        alert.addTextField { field in
            field.placeholder = "Mã PIN"
            field.keyboardType = .numberPad
            field.isSecureTextEntry = true
        }
        alert.addAction(UIAlertAction(title: "Huỷ", style: .cancel))
        alert.addAction(UIAlertAction(title: "Vào", style: .default) { [weak self, weak alert] _ in
            let phone = alert?.textFields?[0].text ?? ""
            let pin = alert?.textFields?[1].text ?? ""
            self?.checkAdmin(phone: phone, pin: pin)
        })
        presentOnTop(alert, retry: 6)
    }

    /// Kiểm tra bằng chính trang web (cùng trang đăng nhập của quán), rồi đăng xuất ngay: máy quầy
    /// không giữ đăng nhập chủ quán.
    private func checkAdmin(phone: String, pin: String) {
        let script = """
        try {
          const r = await fetch('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
          const j = await r.json().catch(() => ({}));
          await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
          if (!r.ok) return { ok: false, error: j.error || 'Sai số điện thoại hoặc mã PIN.' };
          if (!j.user || j.user.role !== 'admin') return { ok: false, error: 'Chỉ chủ quán (admin) vào được.' };
          return { ok: true, name: j.user.full_name || '' };
        } catch (e) {
          return { ok: false, error: 'Mất mạng, thử lại.' };
        }
        """
        webView.callAsyncJavaScript(script, arguments: ["phone": phone, "pin": pin], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            var answer: [String: Any] = ["ok": false, "error": "Trang chưa tải xong, thử lại."]
            if case .success(let value) = result, let dict = value as? [String: Any] { answer = dict }
            if (answer["ok"] as? Bool) == true {
                self.showMenu(name: answer["name"] as? String ?? "")
            } else {
                self.notice(title: "Không vào được", message: answer["error"] as? String ?? "Thử lại.")
            }
        }
    }

    private func showMenu(name: String) {
        let lock = AutoLock.shared
        let paused = lock.paused
        let alert = UIAlertController(title: "Cài đặt máy quầy", message: name.isEmpty ? nil : "Chủ quán: \(name)", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: paused ? "▶️ Chạy lại máy quầy" : "⏸ Tạm dừng máy quầy", style: .default) { [weak self] _ in
            self?.setPaused(!paused)
        })
        alert.addAction(UIAlertAction(title: "🔒 Tự khoá màn hình: \(AutoLock.label(lock.lockAfter))", style: .default) { [weak self] _ in
            self?.showLockChoices(name: name)
        })
        alert.addAction(UIAlertAction(title: "🔄 Tải lại trang", style: .default) { [weak self] _ in self?.load() })
        alert.addAction(UIAlertAction(title: "❓ Không cho thoát app", style: .default) { [weak self] _ in self?.showLockHelp() })
        alert.addAction(UIAlertAction(title: "Đóng", style: .cancel))
        presentOnTop(alert, retry: 6)
    }

    private func showLockChoices(name: String) {
        let current = AutoLock.shared.lockAfter
        let alert = UIAlertController(title: "Tự khoá màn hình sau", message: "Không ai dùng sau chừng này thì màn hình tự khoá. Bấm nút Home để mở lại, app chạy tiếp ngay.", preferredStyle: .alert)
        for seconds in AutoLock.choices {
            let mark = seconds == current ? "✓ " : ""
            alert.addAction(UIAlertAction(title: mark + AutoLock.label(seconds), style: .default) { [weak self] _ in
                AutoLock.shared.lockAfter = seconds
                if seconds > 0 {
                    self?.notice(title: "Đã chọn \(AutoLock.label(seconds))",
                                 message: "Nhớ vào Cài đặt → Màn hình & Độ sáng → Tự động khoá → chọn 30 giây. Không đặt mật mã máy để bấm Home là vào lại app ngay.")
                }
            })
        }
        alert.addAction(UIAlertAction(title: "Quay lại", style: .cancel) { [weak self] _ in self?.showMenu(name: name) })
        presentOnTop(alert, retry: 6)
    }

    private func setPaused(_ on: Bool) {
        AutoLock.shared.paused = on
        pausedCover.isHidden = !on
        if !on { load() }
    }

    private func showLockHelp() {
        notice(title: "Không cho thoát app",
               message: "iPhone có sẵn chế độ khoá trong một app:\n1. Cài đặt → Trợ năng → Truy cập được hướng dẫn → Bật, đặt mã riêng.\n2. Mở app Chấm công, bấm nút Home 3 lần → Bắt đầu.\nTừ lúc đó bấm Home không thoát được. Muốn thoát: bấm Home 3 lần, nhập mã.")
    }

    private func notice(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presentOnTop(alert, retry: 6)
    }

    // MARK: Navigation: stay on the kiosk site, reload when it fails

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let ok = url.scheme == "about" || (url.scheme == kioskURL.scheme && url.host == kioskURL.host && url.port == kioskURL.port)
        decisionHandler(ok ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offline.isHidden = true
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { scheduleReload(after: 1) }

    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        offline.isHidden = false
        scheduleReload(after: 5)
    }

    // MARK: UI requests from the page

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil // no new windows / tabs
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny) // máy quầy không dùng camera
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if !presentOnTop(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Huỷ", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if !presentOnTop(alert) { completionHandler(false) }
    }

    /// Presents over whatever is showing; false when it cannot (then the caller answers at once).
    /// retry: an alert is still closing (a menu button opens the next one) → try again shortly.
    @discardableResult
    private func presentOnTop(_ alert: UIAlertController, retry: Int = 0) -> Bool {
        var top: UIViewController = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        let closing = top.presentedViewController?.isBeingDismissed == true
        if closing || top is UIAlertController {
            guard retry > 0 else { return false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in _ = self?.presentOnTop(alert, retry: retry - 1) }
            return true
        }
        guard top.viewIfLoaded?.window != nil else { return false }
        top.present(alert, animated: true)
        return true
    }
}

/// Keeps the web view's message handler from retaining the controller.
private final class KioskMessages: NSObject, WKScriptMessageHandler {
    private weak var target: KioskViewController?

    init(_ target: KioskViewController) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.handle(message)
    }
}
