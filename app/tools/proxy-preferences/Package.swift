// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ProxyPreferences", platforms: [.macOS(.v13)], products: [
    .library(name: "ProxyPreferencesCore", targets: ["ProxyPreferencesCore"]),
    .executable(name: "JMSProxyPreferences", targets: ["JMSProxyPreferences"])
], targets: [.target(name: "ProxyPreferencesCore"), .executableTarget(name: "JMSProxyPreferences", dependencies: ["ProxyPreferencesCore"]), .testTarget(name: "ProxyPreferencesCoreTests", dependencies: ["ProxyPreferencesCore"])])
