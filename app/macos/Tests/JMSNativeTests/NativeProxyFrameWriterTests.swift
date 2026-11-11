import XCTest
@testable import JMSNative

final class NativeProxyFrameWriterTests: XCTestCase {
    @MainActor func testPartialEAGAINAndConcurrentCancelFrameRemainWhole() async throws {
        let fake = WriterFixture()
        var calls = 0, output = Data()
        let writer = NativeProxyFrameWriter(now: { fake.now }, sleep: { await fake.pause() }, write: { data, offset in
            calls += 1
            if calls == 2 { return 0 } // EAGAIN
            let count = calls == 1 ? 2 : data.count - offset
            output.append(data.subdata(in: offset..<(offset + count))); return count
        })
        let large = Data((String(repeating: "x", count: 1024 * 1024) + "\n").utf8)
        let cancel = Data("{\"type\":\"cancel\"}\n".utf8)
        let first = Task { try await writer.send(large) }
        try await wait { fake.waiting }
        let second = Task { try await writer.send(cancel) }
        try await wait { writer.queuedFrameCount == 2 }
        first.cancel() // Must not cancel the independent, in-flight complete frame.
        fake.resume()
        try await wait { fake.waiting }
        XCTAssertEqual(output.count, 2)
        fake.resume()
        try await first.value; try await second.value
        XCTAssertTrue(output == large + cancel)
        XCTAssertEqual(calls, 4)
        writer.close()
    }
    @MainActor func testTimeoutAndCloseRaceRejectEachWaiterOnceAndNeverWriteAgain() async throws {
        for closeFirst in [false, true] {
            let fake = WriterFixture(); var writes = 0, completions = 0
            let writer = NativeProxyFrameWriter(now: { fake.now }, sleep: { await fake.pause() }, write: { _, _ in writes += 1; return 1 })
            let first = Task { do { try await writer.send(Data("first\n".utf8)); XCTFail("Partial frame succeeded") } catch { completions += 1 } }
            try await wait { fake.waiting }
            let second = Task { do { try await writer.send(Data("second\n".utf8)); XCTFail("Queued frame succeeded") } catch { completions += 1 } }
            try await wait { writer.queuedFrameCount == 2 }
            fake.now = 3
            if closeFirst { writer.close() }
            fake.resume()
            await first.value; await second.value
            writer.close(); writer.close()
            XCTAssertEqual(completions, 2)
            XCTAssertEqual(writes, 1)
            do { try await writer.send(Data("late\n".utf8)); XCTFail("Closed writer accepted frame") } catch { }
            XCTAssertEqual(writes, 1)
        }
    }
    @MainActor func testWriteErrorClosesQueueWithoutLeakingUnderlyingError() async throws {
        let fake = WriterFixture(); var writes = 0
        let writer = NativeProxyFrameWriter(now: { fake.now }, sleep: { await fake.pause() }, write: { _, _ in
            writes += 1
            if writes == 1 { return 1 }
            throw APIError(message: "private underlying error")
        })
        let first = Task { try await writer.send(Data("frame\n".utf8)) }
        try await wait { fake.waiting }
        let second = Task { try await writer.send(Data("cancel\n".utf8)) }
        try await wait { writer.queuedFrameCount == 2 }; fake.resume()
        for task in [first, second] {
            do { try await task.value; XCTFail("Failed channel succeeded") }
            catch { XCTAssertFalse(error.localizedDescription.contains("private underlying error")) }
        }
        XCTAssertEqual(writes, 2)
        do { try await writer.send(Data("late\n".utf8)); XCTFail("Failed writer reused") } catch { }
        XCTAssertEqual(writes, 2)
    }
    @MainActor func testQueueByteAndFrameCapsRejectWithoutAbandoningFirstFrame() async throws {
        let fake = WriterFixture()
        let writer = NativeProxyFrameWriter(now: { fake.now }, sleep: { await fake.pause() }, write: { _, _ in 0 })
        let first = Task { try await writer.send(Data(repeating: 120, count: NativeProxyFrameWriter.maximumBytes)) }
        try await wait { fake.waiting }
        do { try await writer.send(Data([10])); XCTFail("Byte cap exceeded") } catch { }
        writer.close(); fake.resume()
        do { try await first.value; XCTFail("Closed first frame succeeded") } catch { }
        let clock = WriterFixture()
        let bounded = NativeProxyFrameWriter(now: { clock.now }, sleep: { await clock.pause() }, write: { _, _ in 0 })
        var tasks: [Task<Void, Error>] = []
        for _ in 0..<NativeProxyFrameWriter.maximumFrames {
            tasks.append(Task { try await bounded.send(Data([10])) })
            await Task.yield()
        }
        try await wait { clock.waiting && bounded.queuedFrameCount == NativeProxyFrameWriter.maximumFrames }
        do { try await bounded.send(Data([10])); XCTFail("Frame cap exceeded") } catch { }
        bounded.close(); clock.resume()
        for task in tasks { do { try await task.value; XCTFail("Closed queue succeeded") } catch { } }
    }
    @MainActor private func wait(_ predicate: () -> Bool) async throws {
        for _ in 0..<10000 { if predicate() { return }; await Task.yield() }
        throw APIError(message: "Fake writer did not reach expected state")
    }
}
@MainActor private final class WriterFixture {
    var now: Double = 0
    var waiting: Bool { continuation != nil }
    private var continuation: CheckedContinuation<Void, Never>?
    func pause() async { await withCheckedContinuation { continuation = $0 } }
    func resume() { let saved = continuation; continuation = nil; saved?.resume() }
}
