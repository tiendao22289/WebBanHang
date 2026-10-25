import CoreGraphics

/// 8-bit RGBA pixels, row 0 = top of the picture.
public struct RGBAImage {
    public let width: Int
    public let height: Int
    public let pixels: [UInt8]

    public init(width: Int, height: Int, pixels: [UInt8]) {
        precondition(pixels.count == width * height * 4)
        self.width = width; self.height = height; self.pixels = pixels
    }

    /// Draws the picture into an sRGB RGBA buffer (camera frames and JPEGs alike).
    public init?(cgImage: CGImage) {
        let w = cgImage.width, h = cgImage.height
        guard w > 0, h > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        let drawn: Bool = buffer.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .none
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        self.init(width: w, height: h, pixels: buffer)
    }
}

/// Cuts the 112×112 face SFace expects, exactly like OpenCV `alignCrop` + `blobFromImage(swapRB: true)`:
/// five points → least-squares similarity onto the template → bilinear warp (outside = black) →
/// RGB floats 0…255, channel-first (3 × 112 × 112).
public enum FaceAligner {
    public static func transform(points: [CGPoint]) -> SimilarityTransform? {
        guard points.count == 5 else { return nil }
        return SimilarityTransform.estimate(from: points, to: FaceTemplate.points)
    }

    public static func tensor(from image: RGBAImage, points: [CGPoint]) -> [Float]? {
        guard let t = transform(points: points), let inv = t.inverse else { return nil }
        let size = FaceTemplate.size, plane = size * size
        let w = image.width, h = image.height
        var out = [Float](repeating: 0, count: 3 * plane)
        image.pixels.withUnsafeBufferPointer { px in
            func sample(_ x: Int, _ y: Int, _ c: Int) -> Float {
                guard x >= 0, y >= 0, x < w, y < h else { return 0 }
                return Float(px[(y * w + x) * 4 + c])
            }
            for oy in 0..<size {
                for ox in 0..<size {
                    let s = inv.apply(CGPoint(x: ox, y: oy))
                    let sx = Double(s.x), sy = Double(s.y)
                    let x0 = Int(sx.rounded(.down)), y0 = Int(sy.rounded(.down))
                    let fx = Float(sx - Double(x0)), fy = Float(sy - Double(y0))
                    let w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
                    let o = oy * size + ox
                    for c in 0..<3 {
                        out[c * plane + o] = sample(x0, y0, c) * w00 + sample(x0 + 1, y0, c) * w10
                            + sample(x0, y0 + 1, c) * w01 + sample(x0 + 1, y0 + 1, c) * w11
                    }
                }
            }
        }
        return out
    }
}
