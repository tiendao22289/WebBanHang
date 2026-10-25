import CoreGraphics
import Vision

/// A face found by Vision, in image pixels with the origin at the top-left.
public struct LandmarkedFace {
    public let bounds: CGRect
    /// Template order: eye smaller x, eye larger x, nose tip, mouth corner smaller x, mouth corner larger x.
    public let points: [CGPoint]
    public let confidence: Float
}

public enum FaceLandmarker {
    /// The largest face in an upright picture, with the five alignment points.
    public static func largestFace(in image: CGImage) throws -> LandmarkedFace? {
        var request = VNDetectFaceLandmarksRequest()
        do {
            try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
        } catch {
            // No usable GPU / Neural Engine (e.g. a virtual Mac): run Vision on the CPU instead.
            request = VNDetectFaceLandmarksRequest()
            useCPU(request)
            try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
        }
        let size = CGSize(width: image.width, height: image.height)
        let faces = (request.results ?? []).sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
        for face in faces {
            if let points = fivePoints(face, imageSize: size) {
                let b = VNImageRectForNormalizedRect(face.boundingBox, image.width, image.height)
                let bounds = CGRect(x: b.minX, y: size.height - b.maxY, width: b.width, height: b.height)
                return LandmarkedFace(bounds: bounds, points: points, confidence: face.confidence)
            }
        }
        return nil
    }

    static func useCPU(_ request: VNRequest) {
        if #available(iOS 17.0, macOS 14.0, *) {
            guard let stages = try? request.supportedComputeStageDevices() else { return }
            for (stage, devices) in stages {
                if let cpu = devices.first(where: { if case .cpu(_) = $0 { return true } else { return false } }) {
                    request.setComputeDevice(cpu, for: stage)
                }
            }
        } else {
            request.usesCPUOnly = true
        }
    }

    static func fivePoints(_ face: VNFaceObservation, imageSize size: CGSize) -> [CGPoint]? {
        guard let lm = face.landmarks else { return nil }
        // Vision gives image points with the origin at the bottom-left: flip to top-left.
        func pts(_ region: VNFaceLandmarkRegion2D?) -> [CGPoint] {
            guard let region = region, region.pointCount > 0 else { return [] }
            return region.pointsInImage(imageSize: size).map { CGPoint(x: $0.x, y: size.height - $0.y) }
        }
        func centroid(_ p: [CGPoint]) -> CGPoint? {
            guard !p.isEmpty else { return nil }
            return CGPoint(x: p.reduce(0) { $0 + $1.x } / CGFloat(p.count), y: p.reduce(0) { $0 + $1.y } / CGFloat(p.count))
        }
        guard let eyeA = pts(lm.leftPupil).first ?? centroid(pts(lm.leftEye)),
              let eyeB = pts(lm.rightPupil).first ?? centroid(pts(lm.rightEye)) else { return nil }
        let lips = pts(lm.outerLips)
        guard let mouthA = lips.min(by: { $0.x < $1.x }), let mouthB = lips.max(by: { $0.x < $1.x }),
              let nose = noseTip(crest: pts(lm.noseCrest), nose: pts(lm.nose), eyes: (eyeA, eyeB), mouth: (mouthA, mouthB)) else { return nil }
        return FaceTemplate.ordered(eyes: (eyeA, eyeB), nose: nose, mouth: (mouthA, mouthB))
    }

    /// Nose tip: the end of the nose crest (the line down the bridge), the point of it furthest from the eyes.
    /// Without a crest: the middle of the nose outline.
    static func noseTip(crest: [CGPoint], nose: [CGPoint], eyes: (CGPoint, CGPoint), mouth: (CGPoint, CGPoint)) -> CGPoint? {
        let mid = CGPoint(x: (eyes.0.x + eyes.1.x) / 2, y: (eyes.0.y + eyes.1.y) / 2)
        func dist(_ p: CGPoint) -> CGFloat { hypot(p.x - mid.x, p.y - mid.y) }
        if let tip = crest.max(by: { dist($0) < dist($1) }) { return tip }
        guard !nose.isEmpty else { return nil }
        return CGPoint(x: nose.reduce(0) { $0 + $1.x } / CGFloat(nose.count), y: nose.reduce(0) { $0 + $1.y } / CGFloat(nose.count))
    }
}
