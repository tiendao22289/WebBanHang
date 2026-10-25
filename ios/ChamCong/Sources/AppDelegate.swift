import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = KioskWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        window.rootViewController = KioskViewController()
        window.makeKeyAndVisible()
        self.window = window
        Dimmer.shared.attach(to: window)
        // The kiosk stays on; the app darkens the screen itself when nobody uses it.
        application.isIdleTimerDisabled = true
        FaceModel.shared.loadInBackground()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Never leave the phone at brightness 0 outside the app.
        Dimmer.shared.restoreBrightness()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        application.isIdleTimerDisabled = true
        Dimmer.shared.wake(byTouch: false)
    }
}

/// Every touch counts as activity; while the screen is dark, the first touch only wakes it.
final class KioskWindow: UIWindow {
    private var swallowing = false

    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, let touches = event.allTouches {
            if touches.contains(where: { $0.phase == .began }) {
                if Dimmer.shared.isDimmed {
                    swallowing = true
                    Dimmer.shared.wake(byTouch: true)
                } else {
                    Dimmer.shared.poke()
                }
            }
            if swallowing {
                if touches.allSatisfy({ $0.phase == .ended || $0.phase == .cancelled }) { swallowing = false }
                return
            }
        }
        super.sendEvent(event)
    }
}
