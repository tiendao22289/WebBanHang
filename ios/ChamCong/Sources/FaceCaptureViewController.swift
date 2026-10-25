import AVFoundation
import CoreImage
import FaceKit
import UIKit

/// Front-camera screen: the person looks at the camera and blinks; then the app takes the face's
/// embedding(s) and closes. Nothing is saved — no photo leaves this screen, only the numbers.
final class FaceCaptureViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum Mode { case verify, enroll }

    private enum Status: Equatable {
        case starting, noFace, closer, blink, hold

        var text: String {
            switch self {
            case .starting: return "Đang mở camera…"
            case .noFace: return "Đưa mặt vào khung"
            case .closer: return "Lại gần camera hơn"
            case .blink: return "Chớp mắt một cái"
            case .hold: return "Giữ yên…"
            }
        }

        var color: UIColor {
            switch self {
            case .starting, .noFace, .closer: return .white
            case .blink: return UIColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1)
            case .hold: return UIColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1)
            }
        }
    }

    let requestId: Any
    private let mode: Mode
    private let personName: String
    private let prompt: String?
    private var completion: (([String: Any]) -> Void)?

    private let session = AVCaptureSession()
    private let frames = DispatchQueue(label: "chamcong.face-frames")
    private let preview = AVCaptureVideoPreviewLayer()

    // Touched only on the `frames` queue.
    private let detector = CIDetector(ofType: CIDetectorTypeFace, context: nil,
                                      options: [CIDetectorAccuracy: CIDetectorAccuracyLow, CIDetectorTracking: true])
    private let ciContext = CIContext()
    private let tracker = BlinkTracker()
    private var embeddings: [[Float]] = []
    private var lastShot: TimeInterval = 0
    private var blinkAt: TimeInterval?
    private var status: Status = .starting

    private let doneLock = NSLock()
    private var done = false

    private let nameLabel = UILabel()
    private let promptLabel = UILabel()
    private let statusLabel = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let guide = CAShapeLayer()
    private let shade = CAShapeLayer()
    private var startedAt = Date()
    private var timer: Timer?
    private var appeared = false
    private var pendingResult: [String: Any]?

    private var timeout: TimeInterval { mode == .verify ? 20 : 30 }
    private var wanted: Int { mode == .verify ? 2 : 3 }
    private var spacing: TimeInterval { mode == .verify ? 0.15 : 0.25 }

    init(requestId: Any, mode: Mode, name: String, prompt: String?, completion: @escaping ([String: Any]) -> Void) {
        self.requestId = requestId
        self.mode = mode
        self.personName = name
        self.prompt = prompt
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    // MARK: Screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.session = session
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        shade.fillRule = .evenOdd
        shade.fillColor = UIColor(white: 0, alpha: 0.55).cgColor
        view.layer.addSublayer(shade)
        guide.fillColor = UIColor.clear.cgColor
        guide.lineWidth = 5
        guide.strokeColor = UIColor.white.cgColor
        view.layer.addSublayer(guide)

        nameLabel.text = personName.isEmpty ? (mode == .enroll ? "Lấy mặt mẫu" : "Chấm công") : personName
        nameLabel.font = .systemFont(ofSize: 34, weight: .heavy)
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.5
        promptLabel.text = prompt ?? (mode == .enroll ? "Lấy mặt mẫu: nhìn thẳng vào camera và chớp mắt" : "Nhìn vào camera và chớp mắt")
        promptLabel.font = .systemFont(ofSize: 21, weight: .semibold)
        promptLabel.numberOfLines = 0
        statusLabel.font = .systemFont(ofSize: 30, weight: .bold)
        statusLabel.adjustsFontSizeToFitWidth = true
        for label in [nameLabel, promptLabel, statusLabel] {
            label.textColor = .white
            label.textAlignment = .center
            label.shadowColor = UIColor(white: 0, alpha: 0.6)
            label.shadowOffset = CGSize(width: 0, height: 1)
        }
        progress.progressTintColor = UIColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1)
        progress.trackTintColor = UIColor(white: 1, alpha: 0.25)

        let top = UIStackView(arrangedSubviews: [nameLabel, promptLabel])
        top.axis = .vertical
        top.spacing = 6
        let bottom = UIStackView(arrangedSubviews: [statusLabel, progress])
        bottom.axis = .vertical
        bottom.spacing = 14
        if mode == .enroll {
            let cancel = UIButton(type: .system)
            cancel.setTitle("Huỷ", for: .normal)
            cancel.titleLabel?.font = .systemFont(ofSize: 20, weight: .semibold)
            cancel.tintColor = .white
            cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
            bottom.addArrangedSubview(cancel)
        }
        for v in [top, bottom] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: g.topAnchor, constant: 18),
            top.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 20),
            top.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -20),
            bottom.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            bottom.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 28),
            bottom.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -28),
            progress.heightAnchor.constraint(equalToConstant: 8),
        ])
        apply(.starting)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        let w = view.bounds.width * 0.72
        let oval = CGRect(x: (view.bounds.width - w) / 2, y: view.bounds.midY - w * 0.68, width: w, height: w * 1.3)
        guide.path = UIBezierPath(ovalIn: oval).cgPath
        let outside = UIBezierPath(rect: view.bounds)
        outside.append(UIBezierPath(ovalIn: oval))
        shade.path = outside.cgPath
        shade.frame = view.bounds
        guide.frame = view.bounds
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        // Cancelled while still opening: close now that dismissing is possible.
        if let result = pendingResult { pendingResult = nil; return close(with: result) }
        guard timer == nil else { return }
        startedAt = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tickTimer() }
        startCamera()
    }

    private func apply(_ s: Status) {
        statusLabel.text = s.text
        statusLabel.textColor = s.color
        guide.strokeColor = s.color.cgColor
    }

    private func show(_ s: Status) {
        guard s != status else { return }
        status = s
        DispatchQueue.main.async { [weak self] in self?.apply(s) }
    }

    private func tickTimer() {
        let elapsed = Date().timeIntervalSince(startedAt)
        progress.progress = Float(max(0, 1 - elapsed / timeout))
        if elapsed >= timeout { frames.async { [weak self] in self?.timedOut() } }
    }

    @objc private func cancelTapped() { cancel() }

    func cancel() { finish(["ok": false, "reason": "cancelled"]) }

    // MARK: Camera

    private func startCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.configure() } else { self?.cameraRefused() }
                }
            }
        default:
            cameraRefused()
        }
    }

    private func cameraRefused() {
        finish(["ok": false, "reason": "camera", "message": "App chưa được dùng camera: vào Cài đặt > Chấm công > bật Camera."])
    }

    private func configure() {
        frames.async { [weak self] in
            guard let self = self else { return }
            let s = self.session
            s.beginConfiguration()
            s.automaticallyConfiguresApplicationAudioSession = false
            if s.canSetSessionPreset(.vga640x480) { s.sessionPreset = .vga640x480 }
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                  let input = try? AVCaptureDeviceInput(device: device), s.canAddInput(input) else {
                s.commitConfiguration()
                self.finish(["ok": false, "reason": "camera", "message": "Không mở được camera trước."])
                return
            }
            s.addInput(input)
            let output = AVCaptureVideoDataOutput()
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: self.frames)
            guard s.canAddOutput(output) else {
                s.commitConfiguration()
                self.finish(["ok": false, "reason": "camera", "message": "Không đọc được hình từ camera."])
                return
            }
            s.addOutput(output)
            // Frames arrive upright and NOT mirrored (only the preview on screen is mirrored).
            if let c = output.connection(with: .video) {
                if c.isVideoOrientationSupported { c.videoOrientation = .portrait }
                if c.isVideoMirroringSupported {
                    c.automaticallyAdjustsVideoMirroring = false
                    c.isVideoMirrored = false
                }
            }
            s.commitConfiguration()
            s.startRunning()
        }
    }

    // MARK: Frames (on `frames`)

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !isDone, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let image = CIImage(cvPixelBuffer: buffer)
        let extent = image.extent
        let found = (detector?.features(in: image, options: [CIDetectorEyeBlink: true, CIDetectorImageOrientation: 1]) ?? [])
            .compactMap { $0 as? CIFaceFeature }
        guard let face = found.max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
            tracker.update(nil)
            show(.noFace)
            return
        }
        // Core Image puts the origin at the bottom-left; FaceKit works top-left.
        let rect = CGRect(x: face.bounds.minX, y: extent.height - face.bounds.maxY, width: face.bounds.width, height: face.bounds.height)
        guard rect.width >= extent.width * 0.22 else {
            tracker.update(nil)
            show(.closer)
            return
        }
        let blinked = tracker.update(EyeSample(face: rect, leftClosed: face.leftEyeClosed, rightClosed: face.rightEyeClosed, time: time))
        guard blinked else {
            show(.blink)
            return
        }
        if blinkAt == nil { blinkAt = time }
        show(.hold)
        if !face.leftEyeClosed, !face.rightEyeClosed, time - lastShot >= spacing {
            guard let pipeline = FaceModel.shared.get() else {
                finish(["ok": false, "reason": "error", "message": FaceModel.shared.loadError ?? "Chưa mở được mẫu nhận diện khuôn mặt."])
                return
            }
            if let cg = ciContext.createCGImage(image, from: extent), let shot = try? pipeline.embed(cg, near: rect) {
                embeddings.append(shot.embedding)
                lastShot = time
            }
        }
        if embeddings.count >= wanted || (mode == .verify && !embeddings.isEmpty && time - (blinkAt ?? time) > 1.2) {
            finishWithEmbeddings()
        }
    }

    private func timedOut() {
        guard !isDone else { return }
        if mode == .verify, !embeddings.isEmpty { return finishWithEmbeddings() }
        let reason = !tracker.sawFace ? "no_face" : (tracker.blinked ? "no_face" : "no_blink")
        let message = reason == "no_blink" ? "Chưa thấy chớp mắt." : "Không thấy rõ khuôn mặt."
        finish(["ok": false, "reason": reason, "message": message])
    }

    private func finishWithEmbeddings() {
        let vectors = embeddings.map { v in v.map { (Double($0) * 1_000_000).rounded() / 1_000_000 } }
        finish(["ok": true, "live": true, "embeddings": vectors])
    }

    private var isDone: Bool {
        doneLock.lock(); defer { doneLock.unlock() }
        return done
    }

    /// Ends the screen once (any thread): stop the camera, close, report.
    private func finish(_ result: [String: Any]) {
        doneLock.lock()
        if done { doneLock.unlock(); return }
        done = true
        doneLock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.timer?.invalidate()
            self.timer = nil
            if self.appeared { self.close(with: result) } else { self.pendingResult = result }
        }
    }

    private func close(with result: [String: Any]) {
        let report = completion
        completion = nil
        dismiss(animated: false) { report?(result) }
    }
}
