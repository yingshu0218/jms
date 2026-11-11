// swift-tools-version: 5.9
import PackageDescription
import Foundation
// Real isolated IPC smoke is explicitly opt-in; ordinary tests never spawn an engine.
var targets: [Target] = [.executableTarget(name: "JMSNative"), .testTarget(name: "JMSNativeTests", dependencies: ["JMSNative"])]
if ProcessInfo.processInfo.environment["JMS_NATIVE_IPC_SMOKE"] == "1" {
    targets.append(.testTarget(name: "JMSNativeIPCSmokeTests", dependencies: ["JMSNative"]))
}
let package = Package(name: "JMSNative", platforms: [.macOS(.v13)], products: [.executable(name: "JMSNative", targets: ["JMSNative"])], targets: targets)
