// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "JMSNative", platforms: [.macOS(.v13)], products: [.executable(name: "JMSNative", targets: ["JMSNative"])], targets: [.executableTarget(name: "JMSNative"), .testTarget(name: "JMSNativeTests", dependencies: ["JMSNative"])])
