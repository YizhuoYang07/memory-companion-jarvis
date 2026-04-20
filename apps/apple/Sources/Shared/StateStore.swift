import Foundation

actor StateStore {
  private let fileURL: URL
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  // MARK: - Sync load (safe to call from ViewModel.init before actor is shared)

  static func loadSync() -> PersistedState? {
    guard let data = try? Data(contentsOf: Self.storeURL) else { return nil }
    let dec = JSONDecoder()
    dec.dateDecodingStrategy = .iso8601
    return try? dec.decode(PersistedState.self, from: data)
  }

  private static var storeURL: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("Jarvis/state.json")
  }

  // MARK: - Actor instance

  init() {
    let fm = FileManager.default
    let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let dir = base.appendingPathComponent("Jarvis", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    fileURL = dir.appendingPathComponent("state.json")

    let enc = JSONEncoder()
    enc.dateEncodingStrategy = .iso8601
    encoder = enc

    let dec = JSONDecoder()
    dec.dateDecodingStrategy = .iso8601
    decoder = dec
  }

  func load() -> PersistedState? {
    guard let data = try? Data(contentsOf: fileURL) else { return nil }
    return try? decoder.decode(PersistedState.self, from: data)
  }

  func save(_ state: PersistedState) {
    guard let data = try? encoder.encode(state) else { return }
    try? data.write(to: fileURL, options: .atomic)
  }
}
