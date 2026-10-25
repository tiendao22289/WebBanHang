import UIKit
import WebKit

/// Full-screen web view showing the kiosk page (/chamcong). The page talks to the app through
/// `window.webkit.messageHandlers.kiosk.postMessage({type, ...})`: speak, wake, busy, face, cancelFace.
final class KioskViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }

    private let kioskURL: URL
    private var webView: WKWebView!
    private let speaker = Speaker()
    private let offline = UILabel()
    private var reloadWork: DispatchWorkItem?
    private weak var faceScreen: FaceCaptureViewController?

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
        let bootstrap = "window.ChamCongApp = Object.assign(window.ChamCongApp || {}, { version: \(Self.json(Self.version)), face: true, model: 'sface-2021dec' });"
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
        NSLayoutConstraint.activate([
            offline.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            offline.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            offline.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        Dimmer.shared.onWake = { [weak self] in
            self?.webView.evaluateJavaScript("window.ChamCongApp && window.ChamCongApp.onWake && window.ChamCongApp.onWake()", completionHandler: nil)
        }
        load()
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
            if let text = msg["text"] as? String { speaker.speak(text) }
        case "wake":
            Dimmer.shared.wake(byTouch: false)
        case "busy":
            Dimmer.shared.busy = (msg["on"] as? Bool) ?? false
        case "face":
            startFace(msg)
        case "cancelFace":
            if let screen = faceScreen, Self.sameId(screen.requestId, msg["id"]) { screen.cancel() }
        default:
            break
        }
    }

    private func startFace(_ msg: [String: Any]) {
        let id = msg["id"] ?? NSNull()
        guard faceScreen == nil, presentedViewController == nil else {
            sendFace(id, ["ok": false, "reason": "busy"])
            return
        }
        let mode: FaceCaptureViewController.Mode = (msg["mode"] as? String) == "enroll" ? .enroll : .verify
        let screen = FaceCaptureViewController(requestId: id, mode: mode, name: msg["name"] as? String ?? "", prompt: msg["prompt"] as? String) { [weak self] result in
            Dimmer.shared.cameraOpen = false
            self?.sendFace(id, result)
        }
        screen.modalPresentationStyle = .fullScreen
        faceScreen = screen
        Dimmer.shared.cameraOpen = true
        present(screen, animated: false)
    }

    private func sendFace(_ id: Any, _ result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id, result]), let args = String(data: data, encoding: .utf8) else { return }
        let js = "(function(a){var k=window.ChamCongApp;if(k&&typeof k.onFace==='function')k.onFace(a[0],a[1]);})(\(args));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    static func sameId(_ a: Any, _ b: Any?) -> Bool {
        guard let b = b else { return false }
        return "\(a)" == "\(b)"
    }

    static func json(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: s, options: .fragmentsAllowed), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return text
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
        decisionHandler(.deny) // the app owns the camera
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
    private func presentOnTop(_ alert: UIAlertController) -> Bool {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        guard !(top is UIAlertController), top.viewIfLoaded?.window != nil else { return false }
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
