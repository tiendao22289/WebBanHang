// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "FaceKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "FaceKit", targets: ["FaceKit"])],
    targets: [
        .target(name: "FaceKit"),
        .testTarget(name: "FaceKitTests", dependencies: ["FaceKit"], resources: [.copy("Fixtures")]),
    ]
)
