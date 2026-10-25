import FaceKit
import Foundation

/// The face model, loaded once in the background at start (loading takes a moment on an iPhone 6s).
final class FaceModel {
    static let shared = FaceModel()

    private let queue = DispatchQueue(label: "chamcong.face-model")
    private var pipeline: FacePipeline?
    private(set) var loadError: String?

    func loadInBackground() { queue.async { self.load() } }

    /// Waits for the model (call from a background queue).
    func get() -> FacePipeline? { queue.sync { load(); return pipeline } }

    private func load() {
        guard pipeline == nil else { return }
        do {
            guard let url = Bundle.main.url(forResource: "SFace", withExtension: "mlmodelc") else {
                loadError = "Thiếu mẫu nhận diện khuôn mặt trong app."
                return
            }
            let embedder = try FaceEmbedder(compiledModelURL: url)
            // First run compiles the GPU kernels: do it now, not while someone is waiting in front of the camera.
            _ = try? embedder.embedding(for: [Float](repeating: 127, count: 3 * FaceTemplate.size * FaceTemplate.size))
            pipeline = FacePipeline(embedder: embedder)
            loadError = nil
        } catch {
            loadError = "Không mở được mẫu nhận diện khuôn mặt: \(error.localizedDescription)"
        }
    }
}
