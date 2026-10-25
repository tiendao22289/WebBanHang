import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var kiosk: KioskViewController?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = KioskWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        let kiosk = KioskViewController()
        window.rootViewController = kiosk
        window.makeKeyAndVisible()
        self.window = window
        self.kiosk = kiosk
        AutoLock.shared.start()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Vừa mở khoá màn hình (hoặc mở lại app): đếm lại giờ khoá, trang lấy mã mới ngay.
        AutoLock.shared.poke()
        kiosk?.pageWoke()
    }
}

/// Mỗi lần chạm vào màn hình là có người dùng: đếm lại giờ tự khoá.
final class KioskWindow: UIWindow {
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, let touches = event.allTouches, touches.contains(where: { $0.phase == .began }) {
            AutoLock.shared.poke()
        }
        super.sendEvent(event)
    }
}
