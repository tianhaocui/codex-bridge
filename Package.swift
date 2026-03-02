// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexBridgeApp",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CodexBridgeApp", targets: ["CodexBridgeApp"])
    ],
    targets: [
        .executableTarget(
            name: "CodexBridgeApp",
            path: "Sources/CodexBridgeApp"
        )
    ]
)
