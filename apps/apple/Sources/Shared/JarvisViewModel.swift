import Foundation
import Combine

@MainActor
final class JarvisViewModel: ObservableObject {

  // MARK: - Published state

  @Published private(set) var thread: ConversationThread
  @Published private(set) var settings: AppSettings
  @Published private(set) var connectionStatus: ConnectionStatus = .unknown
  @Published private(set) var hasCompletedOnboarding: Bool
  @Published var inputText: String = ""

  // Memory surface
  @Published private(set) var reflections: [BackendReflection] = []
  @Published private(set) var profileFacts: [BackendProfileFact] = []
  @Published private(set) var memoryEvents: [BackendMemoryEvent] = []
  @Published private(set) var isLoadingMemory: Bool = false

  // MARK: - Streaming state (no global isSending bool)

  /// True when the last message in the thread is actively streaming.
  var isStreaming: Bool { thread.hasActiveStream }

  // MARK: - Private

  private let store = StateStore()
  private let client = BackendClient()
  private var activeStreamTask: URLSessionDataTask?   // owned OS-level task for direct cancel

  private var liveSyncTimer: Timer?
  private var lastSyncAt: Date?
  private var memorySurfaceDate: String?   // "yyyy-MM-dd" string — loaded once per calendar day
  private var pendingRecoverySync = false

  // MARK: - Init

  init() {
    if let saved = StateStore.loadSync() {
      self.settings               = saved.settings
      self.thread                 = saved.thread
      self.hasCompletedOnboarding = saved.hasCompletedOnboarding
    } else {
      self.settings               = AppSettings()
      self.thread                 = ConversationThread()
      self.hasCompletedOnboarding = false
    }
  }

  // MARK: - Lifecycle

  func appDidBecomeActive() {
    startLiveSync()
    if pendingRecoverySync {
      pendingRecoverySync = false
      Task { await syncFromServer() }
    }
  }

  func appDidEnterBackground() {
    stopLiveSync()
    // Cancel OS-level URLSession stream task immediately — this unblocks
    // the `bytes.lines` async loop and lets the ViewModel reset cleanly.
    cancelActiveStream(setRecovery: true)
  }

  // MARK: - Settings

  func updateSettings(_ new: AppSettings) {
    settings = new
    persistState()
  }

  func completeOnboarding() {
    hasCompletedOnboarding = true
    persistState()
    Task { await fetchHealth() }
  }

  // MARK: - Send

  func sendMessage() {
    guard !isStreaming else { return }
    let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    inputText = ""

    let userMsg  = Message.userMessage(text: text)
    let streamMsg = Message.streamingPlaceholder()

    thread.messages.append(userMsg)
    thread.messages.append(streamMsg)
    let requestID = streamMsg.id   // String UUID — used as idempotency key

    Task { await performStream(requestID: requestID, streamMsgID: streamMsg.id) }
  }

  // MARK: - New conversation

  func newConversation() {
    cancelActiveStream(setRecovery: false)
    thread = ConversationThread()
    persistState()
  }

  // MARK: - Memory surface

  func loadMemorySurfaceIfNeeded() {
    let today = Date.todayString
    guard today != memorySurfaceDate else { return }
    memorySurfaceDate = today
    Task { await fetchMemorySurface() }
  }

  // MARK: - Private: streaming

  private func performStream(requestID: String, streamMsgID: String) async {
    do {
      try await client.stream(
        settings: settings,
        thread: thread,
        requestID: requestID,
        onTask: { [weak self] task in
          self?.activeStreamTask = task
        },
        onDelta: { [weak self] delta in
          guard let self else { return }
          self.appendDelta(delta, to: streamMsgID)
        }
      )
      finaliseStream(msgID: streamMsgID, error: nil)
    } catch {
      finaliseStream(msgID: streamMsgID, error: error)
    }
  }

  private func appendDelta(_ delta: String, to id: String) {
    guard let idx = thread.messages.firstIndex(where: { $0.id == id }) else { return }
    thread.messages[idx].text += delta
  }

  private func finaliseStream(msgID: String, error: Error?) {
    activeStreamTask = nil
    guard let idx = thread.messages.firstIndex(where: { $0.id == msgID }) else { return }

    if let error {
      let isCancelled = (error as? URLError)?.code == .cancelled
                     || error is CancellationError
      if isCancelled {
        // Silently drop empty placeholder; keep partial content if any
        if thread.messages[idx].text.isEmpty {
          thread.messages.remove(at: idx)
        } else {
          thread.messages[idx].isStreaming = false
        }
      } else {
        let isTimeout = (error as? URLError)?.code == .timedOut
        thread.messages[idx].text  = isTimeout
          ? "Connection timed out. Tap to retry."
          : error.localizedDescription
        thread.messages[idx].isError     = true
        thread.messages[idx].isStreaming = false
      }
    } else {
      thread.messages[idx].isStreaming = false
    }

    persistState()
    scheduleLiveSync()
  }

  // MARK: - Private: sync

  private func syncFromServer() async {
    guard !isStreaming else { return }
    let since60s = lastSyncAt.map { Date().timeIntervalSince($0) < 60 } ?? false
    if since60s { return }
    lastSyncAt = Date()
    do {
      let state = try await client.fetchState(
        settings: settings,
        conversationID: thread.serverConversationID,
        clientConversationID: thread.clientConversationID
      )
      mergeServerState(state)
    } catch {
      // Best-effort; silent failure
    }
  }

  private func mergeServerState(_ state: BackendConversationState) {
    if thread.serverConversationID == nil {
      thread.serverConversationID = state.conversation.id
    }
    let msgs = state.messages
    guard !msgs.isEmpty else { return }
    let existingIDs = Set(thread.messages.compactMap { $0.externalID })
    let newMsgs = msgs
      .filter { !existingIDs.contains($0.id) }
      .map { Message.fromBackend($0) }
    if !newMsgs.isEmpty {
      thread.messages.append(contentsOf: newMsgs)
      persistState()
    }
  }

  // MARK: - Private: LiveSync

  private func startLiveSync() {
    guard liveSyncTimer == nil else { return }
    liveSyncTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in
        guard !self.isStreaming else { return }
        await self.syncFromServer()
      }
    }
  }

  private func stopLiveSync() {
    liveSyncTimer?.invalidate()
    liveSyncTimer = nil
  }

  private func scheduleLiveSync() {
    stopLiveSync()
    startLiveSync()
  }

  // MARK: - Private: health

  private func fetchHealth() async {
    connectionStatus = .checking
    do {
      _ = try await client.fetchHealth(settings: settings)
      connectionStatus = .connected
    } catch {
      connectionStatus = .failed(error.localizedDescription)
    }
  }

  // MARK: - Private: memory surface

  private func fetchMemorySurface() async {
    guard !isLoadingMemory else { return }
    isLoadingMemory = true
    defer { isLoadingMemory = false }
    async let r = client.fetchReflections(settings: settings)
    async let p = client.fetchProfileFacts(settings: settings)
    async let e = client.fetchMemoryEvents(settings: settings)
    let (reflR, profR, evtR) = (try? await r, try? await p, try? await e)
    if let v = reflR { reflections  = v }
    if let v = profR { profileFacts = v }
    if let v = evtR  { memoryEvents = v }
  }

  // MARK: - Private: cancel

  private func cancelActiveStream(setRecovery: Bool) {
    if isStreaming {
      activeStreamTask?.cancel()
      activeStreamTask = nil
      // Remove empty streaming placeholder
      thread.messages.removeAll { $0.isStreaming && $0.text.isEmpty }
      // Mark partial content as non-streaming
      for i in thread.messages.indices where thread.messages[i].isStreaming {
        thread.messages[i].isStreaming = false
      }
      if setRecovery { pendingRecoverySync = true }
    }
  }

  // MARK: - Persist

  private func persistState() {
    let state = PersistedState(settings: settings, thread: thread,
                               hasCompletedOnboarding: hasCompletedOnboarding)
    Task.detached(priority: .background) { [store, state] in
      await store.save(state)
    }
  }
}

// MARK: - Date helper

private extension Date {
  static var todayString: String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f.string(from: Date())
  }
}
