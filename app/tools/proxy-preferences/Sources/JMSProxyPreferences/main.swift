import Foundation
import ProxyPreferencesCore

struct Request: Decodable {
    let operation: String
    let target: Target?
    let expected: Snapshot?
    let desired: Snapshot?
}
struct Response: Encodable {
    let ok = true
    var snapshot: Snapshot? = nil
    var original: Snapshot? = nil
    var target: Snapshot? = nil
    var committed: Bool? = nil
    var applied: Bool? = nil
}
func process() throws -> Data {
    // Interactive transport/authorization is deliberately not enabled by this
    // model-only phase. Even a forged flag never creates an authorization ref.
    if CommandLine.arguments == [CommandLine.arguments[0], "--interactive"] {
        throw Failure(.authorizationRequired, .no)
    }
    // Limit private IPC size before decoding. Never accept argv values or paths.
    guard CommandLine.arguments.count == 1 else { throw Failure(.invalidRequest, .no) }
    let data = FileHandle.standardInput.readData(ofLength: 8 * 1024 * 1024 + 1)
    guard data.count <= 8 * 1024 * 1024,
          let request = try? JSONDecoder().decode(Request.self, from: data) else { throw Failure(.invalidRequest, .no) }
    if request.operation == "observe" {
        guard request.target == nil, request.expected == nil, request.desired == nil else { throw Failure(.invalidRequest, .no) }
        return try JSONEncoder().encode(Response(snapshot: try StableObservation.system()))
    }
    let transaction = Transaction(store: try SystemPreferencesStore())
    let result: Response
    switch request.operation {
    case "snapshot":
        guard request.target == nil, request.expected == nil, request.desired == nil else { throw Failure(.invalidRequest, .no) }
        result = Response(snapshot: try transaction.snapshot())
    case "prepare":
        guard let target = request.target, request.expected == nil, request.desired == nil else { throw Failure(.invalidRequest, .no) }
        let prepared = try transaction.prepare(target)
        result = Response(original: prepared.original, target: prepared.target)
    case "compareAndSet":
        guard let expected = request.expected, let desired = request.desired, request.target == nil else { throw Failure(.invalidRequest, .no) }
        result = Response(snapshot: try transaction.compareAndSet(expected: expected, desired: desired), committed: true, applied: true)
    default: throw Failure(.invalidRequest, .no)
    }
    return try JSONEncoder().encode(result)
}
let output: Data
do { output = try process() }
catch let failure as Failure { output = try! JSONEncoder().encode(failure) }
catch { output = try! JSONEncoder().encode(Failure(.invalidRequest, .unknown)) }
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([10]))
