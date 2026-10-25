import CoreGraphics

/// Picture → largest face (Vision) → aligned 112×112 crop → SFace embedding.
public final class FacePipeline {
    public let embedder: FaceEmbedder

    public init(embedder: FaceEmbedder) {
        self.embedder = embedder
    }

    /// `near` (top-left pixel rect): only accept a face overlapping it, e.g. the face that just blinked.
    public func embed(_ image: CGImage, near: CGRect? = nil) throws -> (face: LandmarkedFace, embedding: [Float])? {
        guard let face = try FaceLandmarker.largestFace(in: image) else { return nil }
        if let near = near, FaceMath.iou(near, face.bounds) < 0.25 { return nil }
        guard let embedding = try embed(image, points: face.points) else { return nil }
        return (face: face, embedding: embedding)
    }

    /// Embedding from known five points (template order, top-left pixel coordinates).
    public func embed(_ image: CGImage, points: [CGPoint]) throws -> [Float]? {
        guard let rgba = RGBAImage(cgImage: image), let tensor = FaceAligner.tensor(from: rgba, points: points) else { return nil }
        return try embedder.embedding(for: tensor)
    }
}
