import CoreGraphics

/// 2D similarity transform (rotation + uniform scale + translation, never a mirror):
/// p ↦ (a·x − b·y + tx, b·x + a·y + ty).
public struct SimilarityTransform: Equatable {
    public var a: Double
    public var b: Double
    public var tx: Double
    public var ty: Double

    public init(a: Double, b: Double, tx: Double, ty: Double) {
        self.a = a; self.b = b; self.tx = tx; self.ty = ty
    }

    public func apply(_ p: CGPoint) -> CGPoint {
        let x = Double(p.x), y = Double(p.y)
        return CGPoint(x: a * x - b * y + tx, y: b * x + a * y + ty)
    }

    public var scale: Double { (a * a + b * b).squareRoot() }

    public var inverse: SimilarityTransform? {
        let d = a * a + b * b
        guard d > 1e-12 else { return nil }
        let ia = a / d, ib = -b / d
        // −A⁻¹·t
        return SimilarityTransform(a: ia, b: ib, tx: -(ia * tx - ib * ty), ty: -(ib * tx + ia * ty))
    }

    /// Least-squares fit of `dst ≈ T(src)` (same closed form as Umeyama without reflection, as used by
    /// OpenCV `FaceRecognizerSF::alignCrop` for an ordinary face).
    public static func estimate(from src: [CGPoint], to dst: [CGPoint]) -> SimilarityTransform? {
        guard src.count == dst.count, src.count >= 2 else { return nil }
        let n = Double(src.count)
        let msx = src.reduce(0) { $0 + Double($1.x) } / n, msy = src.reduce(0) { $0 + Double($1.y) } / n
        let mdx = dst.reduce(0) { $0 + Double($1.x) } / n, mdy = dst.reduce(0) { $0 + Double($1.y) } / n
        var den = 0.0, num1 = 0.0, num2 = 0.0
        for (s, d) in zip(src, dst) {
            let sx = Double(s.x) - msx, sy = Double(s.y) - msy
            let dx = Double(d.x) - mdx, dy = Double(d.y) - mdy
            den += sx * sx + sy * sy
            num1 += sx * dx + sy * dy
            num2 += sx * dy - sy * dx
        }
        guard den > 1e-9 else { return nil }
        let a = num1 / den, b = num2 / den
        return SimilarityTransform(a: a, b: b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy))
    }
}

/// Where the five points of a face land in the 112×112 crop SFace was trained on
/// (eye with smaller x, eye with larger x, nose tip, mouth corner smaller x, mouth corner larger x).
public enum FaceTemplate {
    public static let size = 112
    public static let points: [CGPoint] = [
        CGPoint(x: 38.2946, y: 51.6963), CGPoint(x: 73.5318, y: 51.5014), CGPoint(x: 56.0252, y: 71.7366),
        CGPoint(x: 41.5493, y: 92.3655), CGPoint(x: 70.7299, y: 92.2041),
    ]

    /// Puts any five points in template order: eyes by x, nose, mouth corners by x.
    public static func ordered(eyes: (CGPoint, CGPoint), nose: CGPoint, mouth: (CGPoint, CGPoint)) -> [CGPoint] {
        let e = eyes.0.x <= eyes.1.x ? [eyes.0, eyes.1] : [eyes.1, eyes.0]
        let m = mouth.0.x <= mouth.1.x ? [mouth.0, mouth.1] : [mouth.1, mouth.0]
        return [e[0], e[1], nose, m[0], m[1]]
    }
}

public enum FaceMath {
    public static func normalized(_ v: [Float]) -> [Float] {
        let n = v.reduce(0) { $0 + Double($1) * Double($1) }.squareRoot()
        guard n > 1e-12, n.isFinite else { return v }
        return v.map { Float(Double($0) / n) }
    }

    public static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in 0..<a.count {
            dot += Double(a[i]) * Double(b[i]); na += Double(a[i]) * Double(a[i]); nb += Double(b[i]) * Double(b[i])
        }
        let d = (na * nb).squareRoot()
        return d > 0 ? dot / d : 0
    }

    /// Intersection over union of two rectangles (0 when they do not touch).
    public static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let i = a.intersection(b)
        guard !i.isNull, i.width > 0, i.height > 0 else { return 0 }
        let inter = Double(i.width * i.height)
        return inter / (Double(a.width * a.height) + Double(b.width * b.height) - inter)
    }
}
