import CoreGraphics
import CoreML
import Foundation
import ImageIO
import Vision
import XCTest
@testable import FaceKit

/// Reference numbers come from `ios/tools/reference.py` (OpenCV YuNet points → our warp → SFace in onnxruntime)
/// run on the same fixture JPEGs; see Fixtures/SOURCES.md for where the photos come from.
struct Reference: Decodable {
    let size: [Int]
    let landmarks: [[Double]]
    let embedding: [Float]
    let opencv: [Float]
    let blob_mean: [Double]
    let blob_sample: [Double]
    let blob_stride: Int
}

final class FaceKitTests: XCTestCase {
    static let fixtures = Bundle.module.url(forResource: "Fixtures", withExtension: nil)!
    static let references: [String: Reference] = {
        let data = try! Data(contentsOf: fixtures.appendingPathComponent("reference.json"))
        return try! JSONDecoder().decode([String: Reference].self, from: data)
    }()
    static var names: [String] { references.keys.sorted() }

    static let embedder: FaceEmbedder = {
        // ios/FaceKit/Tests/FaceKitTests/this file → ios/ChamCong/Resources/SFace.mlmodel
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = ios.appendingPathComponent("ChamCong/Resources/SFace.mlmodel")
        let compiled = try! MLModel.compileModel(at: source)
        return try! FaceEmbedder(compiledModelURL: compiled, computeUnits: .cpuOnly)
    }()

    static func image(_ name: String) -> CGImage {
        let src = CGImageSourceCreateWithURL(fixtures.appendingPathComponent(name) as CFURL, nil)!
        return CGImageSourceCreateImageAtIndex(src, 0, nil)!
    }

    static func person(_ name: String) -> String { String(name.split(separator: "_").first!) }

    func testSimilarityTransformRecoversAKnownTransform() {
        let t = SimilarityTransform(a: 0.42 * cos(0.3), b: 0.42 * sin(0.3), tx: -110.5, ty: 37.25)
        let src = [CGPoint(x: 210, y: 300), CGPoint(x: 330, y: 296), CGPoint(x: 270, y: 380), CGPoint(x: 225, y: 450), CGPoint(x: 318, y: 447)]
        let fit = SimilarityTransform.estimate(from: src, to: src.map(t.apply))!
        XCTAssertEqual(fit.a, t.a, accuracy: 1e-9); XCTAssertEqual(fit.b, t.b, accuracy: 1e-9)
        XCTAssertEqual(fit.tx, t.tx, accuracy: 1e-6); XCTAssertEqual(fit.ty, t.ty, accuracy: 1e-6)
        let back = fit.inverse!.apply(fit.apply(CGPoint(x: 12.5, y: -7)))
        XCTAssertEqual(back.x, 12.5, accuracy: 1e-9); XCTAssertEqual(back.y, -7, accuracy: 1e-9)
        // The template mapped onto itself is the identity.
        let id = SimilarityTransform.estimate(from: FaceTemplate.points, to: FaceTemplate.points)!
        XCTAssertEqual(id.a, 1, accuracy: 1e-12); XCTAssertEqual(id.b, 0, accuracy: 1e-12)
        XCTAssertEqual(FaceTemplate.ordered(eyes: (CGPoint(x: 9, y: 1), CGPoint(x: 3, y: 1)), nose: .zero,
                                            mouth: (CGPoint(x: 8, y: 5), CGPoint(x: 2, y: 5))).map(\.x), [3, 9, 0, 2, 8])
    }

    func testAlignedCropMatchesThePythonReference() {
        for name in Self.names {
            let ref = Self.references[name]!
            let rgba = RGBAImage(cgImage: Self.image(name))!
            XCTAssertEqual([rgba.width, rgba.height], ref.size, name)
            let tensor = FaceAligner.tensor(from: rgba, points: ref.landmarks.map { CGPoint(x: $0[0], y: $0[1]) })!
            let plane = FaceTemplate.size * FaceTemplate.size
            for c in 0..<3 {
                let mean = tensor[(c * plane)..<((c + 1) * plane)].reduce(0) { $0 + Double($1) } / Double(plane)
                // JPEG decoders differ by a level or two per pixel.
                XCTAssertEqual(mean, ref.blob_mean[c], accuracy: 1.5, "\(name) channel \(c)")
            }
            let sample = stride(from: 0, to: tensor.count, by: ref.blob_stride).prefix(ref.blob_sample.count).map { Double(tensor[$0]) }
            let diff = zip(sample, ref.blob_sample).map { abs($0 - $1) }.reduce(0, +) / Double(sample.count)
            XCTAssertLessThan(diff, 4, name)
        }
    }

    func testCoreMLEmbeddingMatchesONNX() throws {
        let pipeline = FacePipeline(embedder: Self.embedder)
        for name in Self.names {
            let ref = Self.references[name]!
            let e = try pipeline.embed(Self.image(name), points: ref.landmarks.map { CGPoint(x: $0[0], y: $0[1]) })!
            XCTAssertEqual(e.count, FaceEmbedder.dimension)
            let cos = FaceMath.cosine(e, ref.embedding)
            print(String(format: "core ml vs onnx %@: %.5f", name, cos))
            XCTAssertGreaterThanOrEqual(cos, 0.98, name)
        }
    }

    func testVisionPipelineTellsPeopleApart() throws {
        let pipeline = FacePipeline(embedder: Self.embedder)
        var emb: [String: [Float]] = [:]
        for name in Self.names {
            let img = Self.image(name)
            guard let (face, e) = try pipeline.embed(img) else { XCTFail("no face in \(name)"); continue }
            emb[name] = e
            let ref = Self.references[name]!
            let yunet = ref.landmarks.map { CGPoint(x: $0[0], y: $0[1]) }
            let eyeGap = hypot(yunet[1].x - yunet[0].x, yunet[1].y - yunet[0].y)
            let offsets = zip(face.points, yunet).map { String(format: "(%+.2f,%+.2f)", ($0.x - $1.x) / eyeGap, ($0.y - $1.y) / eyeGap) }
            print("\(name): vision−yunet / eye gap \(offsets.joined(separator: " ")) cos(vision, yunet ref) \(String(format: "%.3f", FaceMath.cosine(e, ref.embedding)))")
            for (label, nose) in noseCandidates(img) {
                let p = [face.points[0], face.points[1], nose, face.points[3], face.points[4]]
                if let alt = try pipeline.embed(img, points: p) {
                    print(String(format: "   nose %@: offset (%+.2f,%+.2f) cos(alt, yunet ref) %.3f", label,
                                 (nose.x - yunet[2].x) / eyeGap, (nose.y - yunet[2].y) / eyeGap, FaceMath.cosine(alt, ref.embedding)))
                }
            }
        }
        var same: [Double] = [], different: [Double] = []
        let names = emb.keys.sorted()
        for (i, a) in names.enumerated() {
            for b in names[(i + 1)...] {
                let c = FaceMath.cosine(emb[a]!, emb[b]!)
                if Self.person(a) == Self.person(b) { same.append(c) } else { different.append(c) }
                print(String(format: "%@ vs %@: %.3f", a, b, c))
            }
        }
        print(String(format: "same person min %.3f, different people max %.3f", same.min() ?? 0, different.max() ?? 0))
        XCTAssertEqual(emb.count, Self.names.count)
        XCTAssertGreaterThan(same.min() ?? 0, different.max() ?? 1)
        XCTAssertGreaterThan(same.min() ?? 0, 0.5)
        XCTAssertLessThan(different.max() ?? 1, 0.4)
    }

    /// Other ways to pick the nose tip from Vision's landmarks, printed for comparison with YuNet's.
    func noseCandidates(_ img: CGImage) -> [(String, CGPoint)] {
        let request = VNDetectFaceLandmarksRequest()
        try? VNImageRequestHandler(cgImage: img, orientation: .up).perform([request])
        guard let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }), let lm = face.landmarks else { return [] }
        let size = CGSize(width: img.width, height: img.height)
        func pts(_ r: VNFaceLandmarkRegion2D?) -> [CGPoint] {
            r?.pointsInImage(imageSize: size).map { CGPoint(x: $0.x, y: size.height - $0.y) } ?? []
        }
        let nose = pts(lm.nose), crest = pts(lm.noseCrest)
        var out: [(String, CGPoint)] = []
        if !nose.isEmpty {
            out.append(("nose centroid", CGPoint(x: nose.map(\.x).reduce(0, +) / CGFloat(nose.count), y: nose.map(\.y).reduce(0, +) / CGFloat(nose.count))))
            if let low = nose.max(by: { $0.y < $1.y }) { out.append(("nose lowest", low)) }
        }
        if let last = crest.last { out.append(("crest last", last)) }
        if let low = crest.max(by: { $0.y < $1.y }) { out.append(("crest lowest", low)) }
        if let c = crest.last, let n = nose.max(by: { $0.y < $1.y }) {
            out.append(("crest/nose mid", CGPoint(x: (c.x + n.x) / 2, y: (c.y + n.y) / 2)))
        }
        return out
    }

    func testBlinkNeedsOpenClosedOpenOnTheSameFace() {
        let face = CGRect(x: 100, y: 100, width: 200, height: 200)
        func run(_ frames: [(Bool, Bool)?], step: TimeInterval = 0.1) -> BlinkTracker {
            let t = BlinkTracker()
            for (i, eyes) in frames.enumerated() {
                t.update(eyes.map { EyeSample(face: face, leftClosed: $0.0, rightClosed: $0.1, time: Double(i) * step) })
            }
            return t
        }
        let o = (false, false), c = (true, true), half = (true, false)
        XCTAssertTrue(run([o, o, c, o, o]).blinked)
        XCTAssertTrue(run([o, o, o, c, c, o, o]).blinked)
        XCTAssertFalse(run([o, o, o, o, o, o]).blinked, "a photo never blinks")
        XCTAssertFalse(run([c, c, o, o]).blinked, "must see open eyes before the blink")
        XCTAssertFalse(run([o, o, c, o]).blinked, "needs two open frames after")
        XCTAssertFalse(run([o, o, half, o, o]).blinked, "one eye is not a blink")
        XCTAssertFalse(run([o, o, c, nil, o, o]).blinked, "face lost in between")
        XCTAssertFalse(run([o, o] + Array(repeating: c, count: 20) + [o, o]).blinked, "eyes shut for two seconds")
        XCTAssertFalse(run([o, o, c, o, o], step: 1.0).blinked, "frames too far apart")
        // The face jumps to somewhere else in the middle: start over.
        let t = BlinkTracker()
        t.update(EyeSample(face: face, leftClosed: false, rightClosed: false, time: 0))
        t.update(EyeSample(face: face, leftClosed: false, rightClosed: false, time: 0.1))
        t.update(EyeSample(face: face, leftClosed: true, rightClosed: true, time: 0.2))
        let other = face.offsetBy(dx: 400, dy: 0)
        t.update(EyeSample(face: other, leftClosed: false, rightClosed: false, time: 0.3))
        t.update(EyeSample(face: other, leftClosed: false, rightClosed: false, time: 0.4))
        XCTAssertFalse(t.blinked)
        XCTAssertTrue(t.sawFace)
    }

    func testEmbedderRejectsWrongInput() {
        XCTAssertThrowsError(try Self.embedder.embedding(for: [0, 1, 2]))
    }
}
