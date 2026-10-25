import CoreML
import Foundation

public enum FaceEmbedderError: Error {
    case badInput
    case noOutput
    case invalidOutput
}

/// SFace (OpenCV Zoo, Apache-2.0) as Core ML: 3×112×112 RGB floats → 128 numbers, L2-normalised.
/// If the GPU gives a broken result (NaN / all zero), it retries once on the CPU and stays there.
public final class FaceEmbedder {
    public static let modelName = "sface-2021dec"
    public static let dimension = 128
    public static let inputName = "data"

    private let url: URL
    private var model: MLModel
    private var computeUnits: MLComputeUnits
    private let lock = NSLock()

    /// `compiledModelURL`: the `.mlmodelc` (inside the app it is compiled by Xcode).
    public init(compiledModelURL: URL, computeUnits: MLComputeUnits = .all) throws {
        url = compiledModelURL
        self.computeUnits = computeUnits
        model = try FaceEmbedder.load(url, computeUnits)
    }

    private static func load(_ url: URL, _ units: MLComputeUnits) throws -> MLModel {
        let config = MLModelConfiguration()
        config.computeUnits = units
        return try MLModel(contentsOf: url, configuration: config)
    }

    public func embedding(for tensor: [Float]) throws -> [Float] {
        guard tensor.count == 3 * FaceTemplate.size * FaceTemplate.size else { throw FaceEmbedderError.badInput }
        lock.lock(); defer { lock.unlock() }
        if let v = try? run(tensor), FaceEmbedder.valid(v) { return FaceMath.normalized(v) }
        guard computeUnits != .cpuOnly else { throw FaceEmbedderError.invalidOutput }
        computeUnits = .cpuOnly
        model = try FaceEmbedder.load(url, .cpuOnly)
        let v = try run(tensor)
        guard FaceEmbedder.valid(v) else { throw FaceEmbedderError.invalidOutput }
        return FaceMath.normalized(v)
    }

    private static func valid(_ v: [Float]) -> Bool {
        v.count == dimension && v.allSatisfy { $0.isFinite } && v.contains { abs($0) > 1e-6 }
    }

    private func run(_ tensor: [Float]) throws -> [Float] {
        let size = FaceTemplate.size
        let input = try MLMultiArray(shape: [1, 3, NSNumber(value: size), NSNumber(value: size)], dataType: .float32)
        let ptr = input.dataPointer.bindMemory(to: Float.self, capacity: tensor.count)
        tensor.withUnsafeBufferPointer { src in ptr.update(from: src.baseAddress!, count: tensor.count) }
        let inputName = model.modelDescription.inputDescriptionsByName[FaceEmbedder.inputName] != nil
            ? FaceEmbedder.inputName : (model.modelDescription.inputDescriptionsByName.keys.first ?? FaceEmbedder.inputName)
        let result = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(multiArray: input)]))
        let outputName = model.modelDescription.outputDescriptionsByName["embedding"] != nil
            ? "embedding" : (model.modelDescription.outputDescriptionsByName.keys.first ?? "embedding")
        guard let out = result.featureValue(for: outputName)?.multiArrayValue else { throw FaceEmbedderError.noOutput }
        guard out.count == FaceEmbedder.dimension else { throw FaceEmbedderError.invalidOutput }
        return (0..<out.count).map { out[$0].floatValue }
    }
}
