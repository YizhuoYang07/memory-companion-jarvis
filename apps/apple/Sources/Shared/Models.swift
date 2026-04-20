import Foundation

// MARK: - Settings

struct AppSettings: Codable, Equatable {
  var backendBaseURL: String = ""
  var apiAuthToken: String = ""
  var model: String = "gpt-4o"
  var systemPrompt: String = AppSettings.defaultSystemPrompt

  static let defaultSystemPrompt = """
  You are a personal memory companion. You remember the user across time.
  Be direct, honest, and precise. Never flatter. Never moralize. Respond in the same language the user uses.
  When they share something, acknowledge it naturally — don't over-explain or over-respond.
  Your edge over every other AI is memory: use it implicitly, never narrate it.
  """
}

// MARK: - Messages

enum MessageRole: String, Codable {
  case user, assistant
}

struct Message: Identifiable, Equatable, Codable {
  var id: String
  var externalID: String? = nil   // set after server confirms message
  var role: MessageRole
  var text: String
  var createdAt: Date
  var isStreaming: Bool = false
  var isError: Bool = false

  static func userMessage(text: String) -> Message {
    Message(id: UUID().uuidString, role: .user, text: text, createdAt: Date())
  }

  static func streamingPlaceholder() -> Message {
    Message(id: UUID().uuidString, role: .assistant, text: "", createdAt: Date(), isStreaming: true)
  }

  static func fromBackend(_ bm: BackendMessage) -> Message {
    Message(id: UUID().uuidString, externalID: bm.id, role: bm.role,
            text: bm.text, createdAt: bm.createdAt)
  }
}

// MARK: - Thread

struct ConversationThread: Identifiable, Codable {
  var id: String = UUID().uuidString
  var serverConversationID: String?
  var clientConversationID: String = UUID().uuidString
  var title: String = "Memory"
  var messages: [Message] = []
  var latestReflectionDate: String?
  var updatedAt: Date = Date()

  var hasActiveStream: Bool {
    messages.last?.isStreaming == true
  }

  static func fresh() -> ConversationThread {
    ConversationThread()
  }
}

// MARK: - Persisted State

struct PersistedState: Codable {
  var settings: AppSettings
  var thread: ConversationThread
  var hasCompletedOnboarding: Bool
}

// MARK: - Backend Response Types

struct BackendConversation: Codable {
  var id: String
  var title: String
  var updatedAt: Date   // JSON key: "updatedAt" from backend (camelCase)
}

struct BackendMessage: Codable {
  var id: String
  var role: MessageRole
  var text: String
  var createdAt: Date           // JSON key: "createdAt" (camelCase from backend)
  var externalMessageKey: String?  // JSON key: "externalMessageKey"
}

struct BackendConversationState: Codable {
  var conversation: BackendConversation
  var messages: [BackendMessage]   // JSON key "messages" — always an array
  var latestReflection: BackendReflection?  // JSON key "latestReflection"
  var profileFacts: [BackendProfileFact]    // JSON key "profileFacts"
}

struct BackendHealth: Codable {
  var ok: Bool
}

struct BackendReflection: Identifiable, Codable {
  var id: String
  var reflectionDate: String   // JSON key "reflectionDate"
  var summary: String
  var openLoops: [String]      // JSON key "openLoops"
}

struct BackendProfileFact: Identifiable, Codable {
  var id: String
  var kind: String
  var value: String
}

struct BackendMemoryEvent: Identifiable, Codable {
  var id: String
  var summary: String
  var createdAt: Date   // JSON key "createdAt"
}

// MARK: - API Payloads

struct ChatCompletionPayload: Encodable {
  var model: String
  var stream: Bool
  var messages: [OutboundMessage]
  var metadata: Metadata

  struct OutboundMessage: Encodable {
    var role: String
    var content: String
  }

  struct Metadata: Encodable {
    var conversationId: String?
    var clientConversationId: String?
    var requestId: String

    enum CodingKeys: String, CodingKey {
      case conversationId = "conversationId"
      case clientConversationId = "clientConversationId"
      case requestId = "requestId"
    }
  }
}

enum BackendError: Error {
  case invalidURL
  case httpError(Int, String)
  case loopbackNotAllowedOnDevice
}

// MARK: - Connection Status

enum ConnectionStatus: Equatable {
  case unknown
  case checking
  case connected
  case failed(String)
}
