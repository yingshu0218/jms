import XCTest
@testable import JMSNative

final class ConnectionTests: XCTestCase {
    func testDecodeCoreConnectionAndSearch() throws {
        let json = #"{"running":true,"uploadTotal":123,"downloadTotal":456,"connections":[{"id":"unique","metadata":{"network":"tcp","host":"Example.org","sourceIP":"127.0.0.1","destinationIP":"192.0.2.1","processPath":"/Applications/Browser.app/Browser"},"chains":["Proxy","Node"],"rule":"DomainSuffix","rulePayload":"example.org","upload":12,"download":34}]}"#
        let data = try JSONDecoder().decode(ConnectionsSnapshot.self, from: Data(json.utf8))
        let row = try XCTUnwrap(data.connections.first)
        XCTAssertEqual(row.id, "unique")
        XCTAssertEqual(row.destination, "Example.org")
        XCTAssertEqual(row.application, "Browser")
        XCTAssertTrue(row.matches(" EXAMPLE "))
        XCTAssertTrue(row.matches("192.0.2.1"))
        XCTAssertTrue(row.matches("browser"))
        XCTAssertTrue(row.matches("Node"))
        XCTAssertFalse(row.matches("unrelated"))
        XCTAssertEqual(data.downloadTotal, 456)
    }
    func testMissingMetadataFieldsAndEmptyState() throws {
        let row = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"x","metadata":{}}"#.utf8))
        XCTAssertEqual(row.destination, "未知目标")
        XCTAssertEqual(row.application, "未知应用")
        XCTAssertTrue(row.matches(""))
        let snapshot = try JSONDecoder().decode(ConnectionsSnapshot.self, from: Data(#"{"running":false,"connections":[],"uploadTotal":0,"downloadTotal":0}"#.utf8))
        XCTAssertFalse(snapshot.running)
        XCTAssertTrue(snapshot.connections.isEmpty)
    }
}
