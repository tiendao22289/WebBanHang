import UIKit

/// Screen saver for the counter phone: after `idleSeconds` without a touch the screen goes black at
/// brightness 0; a tap (or the web page asking) brings it back. Never while the camera is open or the
/// page says it is busy.
final class Dimmer {
    static let shared = Dimmer()

    var idleSeconds: TimeInterval = 10
    private(set) var isDimmed = false
    var busy = false { didSet { if busy { wake(byTouch: false) } else { poke() } } }
    var cameraOpen = false { didSet { if cameraOpen { wake(byTouch: false) } else { poke() } } }
    /// Called after a wake-up (tap or page), to let the page refresh its code at once.
    var onWake: (() -> Void)?

    private weak var window: UIWindow?
    private var lastActivity = Date()
    private var savedBrightness: CGFloat?
    private var timer: Timer?
    private let curtain: UIView = {
        let v = UIView()
        v.backgroundColor = .black
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        return v
    }()

    func attach(to window: UIWindow) {
        self.window = window
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func poke() { lastActivity = Date() }

    private func tick() {
        guard !isDimmed, !busy, !cameraOpen, UIApplication.shared.applicationState == .active else { return }
        if Date().timeIntervalSince(lastActivity) >= idleSeconds { dim() }
    }

    private func dim() {
        guard let window = window else { return }
        savedBrightness = UIScreen.main.brightness
        curtain.frame = window.bounds
        window.addSubview(curtain)
        UIScreen.main.brightness = 0
        isDimmed = true
    }

    func wake(byTouch: Bool) {
        poke()
        guard isDimmed else { return }
        isDimmed = false
        curtain.removeFromSuperview()
        if let b = savedBrightness { UIScreen.main.brightness = b }
        savedBrightness = nil
        onWake?()
    }

    func restoreBrightness() {
        if isDimmed, let b = savedBrightness { UIScreen.main.brightness = b }
    }
}
