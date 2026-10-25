import UIKit

/// Tự khoá màn hình khi không ai dùng. App giữ màn hình sáng khi có người chạm (hoặc trang đang báo
/// kết quả), rồi sau `lockAfter` giây không ai dùng thì để iPhone tự khoá như bình thường (Cài đặt →
/// Màn hình & Độ sáng → Tự động khoá đặt 30 giây, mức ngắn nhất của iPhone). Mở khoá là app chạy lại.
/// lockAfter = 0: không tự khoá. Khi tạm dừng máy quầy: theo đúng cài đặt của máy.
final class AutoLock {
    static let shared = AutoLock()
    /// Tự động khoá ngắn nhất của iPhone.
    static let systemLock: TimeInterval = 30
    static let choices: [TimeInterval] = [30, 60, 120, 300, 600, 0]

    var lockAfter: TimeInterval {
        get { UserDefaults.standard.object(forKey: "lockAfter") as? Double ?? 60 }
        set { UserDefaults.standard.set(newValue, forKey: "lockAfter"); poke() }
    }
    var paused: Bool {
        get { UserDefaults.standard.bool(forKey: "paused") }
        set { UserDefaults.standard.set(newValue, forKey: "paused"); poke() }
    }
    /// Trang đang báo kết quả quét: chưa khoá.
    var busy = false { didSet { poke() } }

    private var lastActivity = Date()
    private var timer: Timer?

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.apply() }
        poke()
    }

    /// Có người dùng (chạm, trang báo): đếm lại từ đầu.
    func poke() {
        lastActivity = Date()
        apply()
    }

    private func apply() {
        let keepOn: Bool
        if paused { keepOn = false }
        else if lockAfter <= 0 || busy { keepOn = true }
        else { keepOn = Date().timeIntervalSince(lastActivity) < max(0, lockAfter - Self.systemLock) }
        if UIApplication.shared.isIdleTimerDisabled != keepOn { UIApplication.shared.isIdleTimerDisabled = keepOn }
    }

    static func label(_ seconds: TimeInterval) -> String {
        if seconds <= 0 { return "Không tự khoá" }
        if seconds < 60 { return "\(Int(seconds)) giây" }
        return "\(Int(seconds / 60)) phút"
    }
}
