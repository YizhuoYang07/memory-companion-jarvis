import Foundation

struct BackendClient {

  // MARK: - Session

  private static func makeSession() -> URLSession {
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 30   // 30s: guarantees frozen streams always unblock
    cfg.timeoutIntervalForResource = 300
    return URLSession(configuration: cfg)
  }

  private let session = BackendClient.makeSession()
  private let decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return d
  }()
  private let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .iso8601
    return e
  }()

  // MARK: - Health

  func fetchHealth(settings: AppSettings) async throws -> BackendHealth {
    let req = try request(path: "/health", settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(BackendHealth.self, from: data)
  }

  // MARK: - Conversations

  func listConversations(settings: AppSettings) async throws -> [BackendConversation] {
    let req = try request(path: "/v1/conversations", settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(ConversationsResponse.self, from: data).conversations
  }

  // MARK: - State

  func fetchState(settings: AppSettings, conversationID: String?, clientConversationID: String?) async throws -> BackendConversationState {
    var comps = URLComponents(url: try baseURL(settings).appendingPathComponent("v1/client/state"),
                              resolvingAgainstBaseURL: false)
    var items: [URLQueryItem] = []
    if let cid = conversationID { items.append(.init(name: "conversationId", value: cid)) }
    if let ccid = clientConversationID { items.append(.init(name: "clientConversationId", value: ccid)) }
    comps?.queryItems = items.isEmpty ? nil : items
    guard let url = comps?.url else { throw BackendError.invalidURL }
    var req = URLRequest(url: url)
    applyHeaders(&req, settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(BackendConversationState.self, from: data)
  }

  // MARK: - Streaming

  /// Streams a chat completion. Calls `onTask` immediately with the underlying
  /// URLSessionDataTask so the caller can cancel the OS-level network task directly.
  /// Returns when [DONE] is received or throws on error/timeout/cancellation.
  func stream(
    settings: AppSettings,
    thread: ConversationThread,
    requestID: String,
    onTask: @escaping @MainActor (URLSessionDataTask) -> Void,
    onDelta: @escaping @MainActor (String) -> Void
  ) async throws {
    var req = try request(path: "/v1/chat/completions", settings: settings)
    req.httpMethod = "POST"
    req.httpBody = try encoder.encode(buildPayload(settings: settings, thread: thread,
                                                    requestID: requestID, stream: true))

    let (bytes, res) = try await session.bytes(for: req)
    try validate(res, data: nil)
    await onTask(bytes.task)

    for try await line in bytes.lines {
      guard line.hasPrefix("data: ") else { continue }
      let payload = String(line.dropFirst(6))
      if payload == "[DONE]" { return }
      if let chunk = try? decoder.decode(StreamChunk.self, from: Data(payload.utf8)),
         let delta = chunk.choices.first?.delta.content, !delta.isEmpty {
        await onDelta(delta)
      }
    }
  }

  // MARK: - Memory Surface

  func fetchReflections(settings: AppSettings) async throws -> [BackendReflection] {
    let req = try request(path: "/v1/reflections", settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(ReflectionsResponse.self, from: data).reflections
  }

  func fetchProfileFacts(settings: AppSettings) async throws -> [BackendProfileFact] {
    let req = try request(path: "/v1/profile-facts", settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(ProfileFactsResponse.self, from: data).profileFacts
  }

  func fetchMemoryEvents(settings: AppSettings) async throws -> [BackendMemoryEvent] {
    let req = try request(path: "/v1/memory-events", settings: settings)
    let (data, res) = try await session.data(for: req)
    try validate(res, data: data)
    return try decoder.decode(MemoryEventsResponse.self, from: data).memoryEvents
  }

  // MARK: - Helpers

  private func buildPayload(settings: AppSettings, thread: ConversationThread,
                             requestID: String, stream: Bool) -> ChatCompletionPayload {
    var outbound: [ChatCompletionPayload.OutboundMessage] = []
    outbound.append(.init(role: "system", content: settings.systemPrompt))
    for msg in thread.messages where !msg.isStreaming && !msg.isError {
      outbound.append(.init(role: msg.role.rawValue, content: msg.text))
    }
    return ChatCompletionPayload(
      model: settings.model,
      stream: stream,
      messages: outbound,
      metadata: .init(
        conversationId: thread.serverConversationID,
        clientConversationId: thread.clientConversationID,
        requestId: requestID
      )
    )
  }

  private func baseURL(_ settings: AppSettings) throws -> URL {
    let raw = settings.backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: raw), url.scheme != nil else { throw BackendError.invalidURL }
#if os(iOS) && !targetEnvironment(simulator)
    if let host = url.host?.lowercased(), host == "localhost" || host == "127.0.0.1" {
      throw BackendError.loopbackNotAllowedOnDevice
    }
#endif
    return url
  }

  private func request(path: String, settings: AppSettings) throws -> URLRequest {
    let url = try baseURL(settings).appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    var req = URLRequest(url: url)
    applyHeaders(&req, settings: settings)
    return req
  }

  private func applyHeaders(_ req: inout URLRequest, settings: AppSettings) {
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    let token = settings.apiAuthToken.trimmingCharacters(in: .whitespacesAndNewlines)
    if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
  }

  private func validate(_ response: URLResponse, data: Data?) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard (200..<300).contains(http.statusCode) else {
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      throw BackendError.httpError(http.statusCode, body)
    }
  }

  // MARK: - Codable helpers

  private struct ConversationsResponse: Decodable {
    var conversations: [BackendConversation]
  }
  private struct ReflectionsResponse: Decodable {
    var reflections: [BackendReflection]
  }
  private struct ProfileFactsResponse: Decodable {
    var profileFacts: [BackendProfileFact]
    enum CodingKeys: String, CodingKey { case profileFacts = "profileFacts" }
  }
  private struct MemoryEventsResponse: Decodable {
    var memoryEvents: [BackendMemoryEvent]
    enum CodingKeys: String, CodingKey { case memoryEvents = "memoryEvents" }
  }
  private struct StreamChunk: Decodable {
    var choices: [Choice]
    struct Choice: Decodable {
      var delta: Delta
    }
    struct Delta: Decodable {
      var content: String?
    }
  }
}
