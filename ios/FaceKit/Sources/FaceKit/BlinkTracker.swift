import CoreGraphics
import Foundation

/// One camera frame's face as seen by the eye-blink detector.
public struct EyeSample {
    public let face: CGRect
    public let leftClosed: Bool
    public let rightClosed: Bool
    public let time: TimeInterval

    public init(face: CGRect, leftClosed: Bool, rightClosed: Bool, time: TimeInterval) {
        self.face = face; self.leftClosed = leftClosed; self.rightClosed = rightClosed; self.time = time
    }
}

/// Liveness by blinking: the same face must show open eyes, then both eyes closed, then open eyes again.
/// A printed photo never closes its eyes; losing or switching the face starts over.
public final class BlinkTracker {
    public private(set) var blinked = false
    public private(set) var sawFace = false
    /// Face of the frames that made the blink (to make sure the face we then embed is the same one).
    public private(set) var face: CGRect?

    private let openBefore: Int
    private let openAfter: Int
    private let maxClosed: TimeInterval
    private var openRun = 0
    private var armed = false
    private var closedAt: TimeInterval?
    private var lastTime: TimeInterval?

    public init(openBefore: Int = 2, openAfter: Int = 2, maxClosed: TimeInterval = 1.5) {
        self.openBefore = openBefore; self.openAfter = openAfter; self.maxClosed = maxClosed
    }

    public func reset() {
        blinked = false; openRun = 0; armed = false; closedAt = nil; face = nil
    }

    /// Feed one frame (nil = no face in it). Returns true once a blink has been seen.
    @discardableResult
    public func update(_ sample: EyeSample?) -> Bool {
        guard let s = sample else {
            if !blinked { reset() }
            return blinked
        }
        sawFace = true
        defer { lastTime = s.time }
        if let previous = face, FaceMath.iou(previous, s.face) < 0.3 {
            // Another face (or a jump): start again with this one.
            reset()
        }
        if let t = lastTime, s.time - t > 0.7, !blinked { reset() }
        face = s.face
        if blinked { return true }

        let closed = s.leftClosed && s.rightClosed
        let open = !s.leftClosed && !s.rightClosed
        if open {
            openRun += 1
            if closedAt != nil {
                if openRun >= openAfter { blinked = true }
            } else if openRun >= openBefore {
                armed = true
            }
        } else if closed {
            openRun = 0
            if let c = closedAt {
                // Eyes shut far too long is not a blink: wait for open eyes again.
                if s.time - c > maxClosed { closedAt = nil; armed = false }
            } else if armed {
                closedAt = s.time
            }
        }
        // One eye open, one shut: ignore the frame.
        return blinked
    }
}
