// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OatheNotch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "OatheNotch", path: "Sources/OatheNotch"),
    ]
)
