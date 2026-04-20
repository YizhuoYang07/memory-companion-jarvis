import SwiftUI

// MARK: - Design System

private extension Color {
  // Brand palette derived from the Möbius-ring icon
  static let brandBackground   = Color("BrandBackground")    // light: #F5F0EA  dark: #1C1A17
  static let brandSurface      = Color("BrandSurface")       // light: #EEEAD4  dark: #242220
  static let brandAccent       = Color("BrandAccent")        // #C9B08A champagne gold
  static let brandText         = Color("BrandText")          // light: #1C1A17  dark: #F0EBE3
  static let brandSubtle       = Color("BrandSubtle")        // light: #8A7F72  dark: #7A706A
  static let userBubble        = Color("UserBubble")         // light: #2B2822  dark: #E8E2D8
  static let userBubbleText    = Color("UserBubbleText")     // light: #F5F0EA  dark: #1C1A17
  static let assistantBubble   = Color("AssistantBubble")    // light: #EEEAD4  dark: #2C2926
}

// MARK: - Root

struct ChatView: View {
  @EnvironmentObject var vm: JarvisViewModel
  @State private var showSettings = false
  @State private var showMemory   = false

  var body: some View {
    NavigationStack {
      ZStack {
        Color.brandBackground.ignoresSafeArea()
        VStack(spacing: 0) {
          messageList
          Divider().background(Color.brandSubtle.opacity(0.2))
          inputBar
        }
      }
      .navigationTitle("")
      .toolbar { toolbar }
      .sheet(isPresented: $showSettings) {
        SettingsView()
          .environmentObject(vm)
#if os(macOS)
          .frame(minWidth: 480, minHeight: 360)
#endif
      }
      .sheet(isPresented: $showMemory) {
        MemoryView()
          .environmentObject(vm)
#if os(macOS)
          .frame(minWidth: 520, minHeight: 480)
#endif
      }
    }
  }

  // MARK: - Message list

  private var messageList: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(vm.thread.messages) { msg in
            MessageRow(message: msg)
              .id(msg.id)
          }
          // invisible anchor at the bottom
          Color.clear.frame(height: 12).id("bottom")
        }
        .padding(.vertical, 8)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: vm.thread.messages.count) { _, _ in
        scrollToBottom(proxy, animated: true)
      }
      .onChange(of: vm.thread.messages.last?.text) { _, _ in
        // follow live streaming text growth
        if vm.isStreaming { scrollToBottom(proxy, animated: false) }
      }
      .task(id: vm.thread.id) {
        scrollToBottom(proxy, animated: false)
      }
    }
  }

  private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
    if animated {
      withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
    } else {
      proxy.scrollTo("bottom", anchor: .bottom)
    }
  }

  // MARK: - Input bar

  private var inputBar: some View {
    HStack(alignment: .bottom, spacing: 10) {
      BubbleTextEditor(text: $vm.inputText) {
        vm.sendMessage()
      }
      sendButton
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(Color.brandBackground)
  }

  private var sendButton: some View {
    Button {
      vm.sendMessage()
    } label: {
      if vm.isStreaming {
        ProgressView()
          .progressViewStyle(.circular)
          .tint(Color.brandAccent)
          .frame(width: 36, height: 36)
      } else {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 32))
          .foregroundStyle(vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                           ? Color.brandSubtle.opacity(0.4)
                           : Color.brandAccent)
      }
    }
    .disabled(vm.isStreaming || vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    .buttonStyle(.plain)
    .frame(width: 36, height: 36)
    .padding(.bottom, 3)
  }

  // MARK: - Toolbar

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .principal) {
      connectionIndicator
    }
#if os(iOS)
    ToolbarItem(placement: .topBarLeading) {
      Button {
        vm.newConversation()
      } label: {
        Image(systemName: "square.and.pencil")
          .foregroundStyle(Color.brandSubtle)
      }
      .buttonStyle(.plain)
    }
    ToolbarItem(placement: .topBarTrailing) {
      HStack(spacing: 16) {
        Button {
          vm.loadMemorySurfaceIfNeeded()
          showMemory = true
        } label: {
          Image(systemName: "brain")
            .foregroundStyle(Color.brandSubtle)
        }
        .buttonStyle(.plain)
        Button {
          showSettings = true
        } label: {
          Image(systemName: "gearshape")
            .foregroundStyle(Color.brandSubtle)
        }
        .buttonStyle(.plain)
      }
    }
#else
    // macOS: all toolbar actions in trailing area with native .borderless style
    ToolbarItem(placement: .automatic) {
      HStack(spacing: 2) {
        Button {
          vm.newConversation()
        } label: {
          Image(systemName: "square.and.pencil")
        }
        .help("New Conversation (⌘N)")
        Button {
          vm.loadMemorySurfaceIfNeeded()
          showMemory = true
        } label: {
          Image(systemName: "brain")
        }
        .help("Memory")
        Button {
          showSettings = true
        } label: {
          Image(systemName: "gearshape")
        }
        .help("Settings")
      }
      .buttonStyle(.borderless)
      .foregroundStyle(Color.brandSubtle)
    }
#endif
  }

  private var connectionIndicator: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(statusColor)
        .frame(width: 6, height: 6)
      Text("Jarvis")
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(Color.brandText)
    }
  }

  private var statusColor: Color {
    switch vm.connectionStatus {
    case .connected:       return .green
    case .checking:        return .yellow
    case .failed:          return .red
    case .unknown:         return Color.brandSubtle.opacity(0.5)
    }
  }
}

// MARK: - Message Row

private struct MessageRow: View {
  let message: Message

  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      if message.role == .user { Spacer(minLength: 48) }
      bubble
      if message.role == .assistant { Spacer(minLength: 48) }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
  }

  @ViewBuilder
  private var bubble: some View {
    if message.isError {
      errorBubble
    } else if message.role == .user {
      userBubble
    } else {
      assistantBubble
    }
  }

  private var userBubble: some View {
    Text(message.text)
      .font(.system(size: 16))
      .foregroundStyle(Color.userBubbleText)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Color.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .textSelection(.enabled)
  }

  private var assistantBubble: some View {
    VStack(alignment: .leading, spacing: 0) {
      if message.isStreaming && message.text.isEmpty {
        typingIndicator
      } else {
        MarkdownText(message.text)
          .font(.system(size: 16))
          .foregroundStyle(Color.brandText)
          .textSelection(.enabled)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(Color.assistantBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
  }

  private var errorBubble: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.circle")
        .font(.system(size: 14))
      Text(message.text)
        .font(.system(size: 14))
    }
    .foregroundStyle(.red.opacity(0.8))
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  private var typingIndicator: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { i in
        TypingDot(delay: Double(i) * 0.18)
      }
    }
    .frame(height: 16)
  }
}

// MARK: - Typing Dot

private struct TypingDot: View {
  let delay: Double
  @State private var on = false

  var body: some View {
    Circle()
      .fill(Color.brandSubtle.opacity(on ? 0.9 : 0.3))
      .frame(width: 7, height: 7)
      .animation(.easeInOut(duration: 0.55).repeatForever().delay(delay), value: on)
      .onAppear { on = true }
  }
}

// MARK: - Markdown Text

/// Lightweight markdown renderer: bold, italic, inline code, code blocks.
private struct MarkdownText: View {
  let raw: String

  init(_ raw: String) { self.raw = raw }

  var body: some View {
    // Prefer AttributedString parsing for rendered markdown
    if let attributed = try? AttributedString(markdown: raw,
                                               options: .init(allowsExtendedAttributes: true,
                                                              interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
      Text(attributed)
    } else {
      Text(raw)
    }
  }
}

// MARK: - BubbleTextEditor

/// Expanding multi-line text field that matches the bubble aesthetic.
private struct BubbleTextEditor: View {
  @Binding var text: String
  var onSubmit: () -> Void
  @State private var editorHeight: CGFloat = 40

  var body: some View {
    ZStack(alignment: .leading) {
      if text.isEmpty {
        Text("Message")
          .font(.system(size: 16))
          .foregroundStyle(Color.brandSubtle.opacity(0.5))
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .allowsHitTesting(false)
      }
      TextEditor(text: $text)
        .font(.system(size: 16))
        .foregroundStyle(Color.brandText)
        .scrollContentBackground(.hidden)
        .background(.clear)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        // constrain height: min 40, max 120
        .frame(minHeight: 40, maxHeight: 120)
        .fixedSize(horizontal: false, vertical: true)
#if os(macOS)
        // macOS: Return = 发送，Command+Return / Shift+Return = 换行
        .onKeyPress { keyPress in
          guard keyPress.key == .return else { return .ignored }
          if keyPress.modifiers.contains(.command) || keyPress.modifiers.contains(.shift) {
            return .ignored  // 让系统插入换行
          }
          onSubmit()
          return .handled
        }
#else
        .onSubmit(onSubmit)
#endif
    }
    .background(Color.brandSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
  }
}

// MARK: - Settings View

struct SettingsView: View {
  @EnvironmentObject var vm: JarvisViewModel
  @Environment(\.dismiss) var dismiss
  @State private var draftURL   = ""
  @State private var draftToken = ""
  @State private var draftPrompt = ""

  var body: some View {
    NavigationStack {
      ZStack {
        Color.brandBackground.ignoresSafeArea()
        Form {
          Section("Backend") {
            LabeledContent("URL") {
              TextField("https://…", text: $draftURL)
                .textContentType(.URL)
                .autocorrectionDisabled()
#if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
#endif
            }
            LabeledContent("Token") {
              SecureField("auth token", text: $draftToken)
                .autocorrectionDisabled()
#if os(iOS)
                .textInputAutocapitalization(.never)
#endif
            }
          }
          Section("System Prompt") {
            TextEditor(text: $draftPrompt)
              .font(.system(size: 14, design: .monospaced))
              .frame(minHeight: 120)
          }
        }
        .scrollContentBackground(.hidden)
      }
      .navigationTitle("Settings")
#if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
#endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.foregroundStyle(Color.brandSubtle)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { save() }
            .foregroundStyle(Color.brandAccent)
            .bold()
        }
      }
      .onAppear {
        draftURL    = vm.settings.backendBaseURL
        draftToken  = vm.settings.apiAuthToken
        draftPrompt = vm.settings.systemPrompt
      }
    }
  }

  private func save() {
    var s = vm.settings
    s.backendBaseURL = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
    s.apiAuthToken   = draftToken.trimmingCharacters(in: .whitespacesAndNewlines)
    s.systemPrompt   = draftPrompt
    vm.updateSettings(s)
    dismiss()
  }
}

// MARK: - Memory View

struct MemoryView: View {
  @EnvironmentObject var vm: JarvisViewModel
  @Environment(\.dismiss) var dismiss

  var body: some View {
    NavigationStack {
      ZStack {
        Color.brandBackground.ignoresSafeArea()
        Group {
          if vm.isLoadingMemory {
            ProgressView("Loading…")
              .tint(Color.brandAccent)
          } else {
            memoryContent
          }
        }
      }
      .navigationTitle("Memory")
#if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
#endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }.foregroundStyle(Color.brandAccent)
        }
      }
    }
  }

  private var memoryContent: some View {
    List {
      if !vm.reflections.isEmpty {
        Section("Reflections") {
          ForEach(vm.reflections) { r in
            VStack(alignment: .leading, spacing: 4) {
              Text(r.reflectionDate)
                .font(.caption)
                .foregroundStyle(Color.brandSubtle)
              Text(r.summary)
                .font(.system(size: 14))
                .foregroundStyle(Color.brandText)
            }
            .padding(.vertical, 2)
          }
        }
      }
      if !vm.profileFacts.isEmpty {
        Section("About You") {
          ForEach(vm.profileFacts) { f in
            VStack(alignment: .leading, spacing: 2) {
              Text(f.kind)
                .font(.caption)
                .foregroundStyle(Color.brandSubtle)
              Text(f.value)
                .font(.system(size: 14))
                .foregroundStyle(Color.brandText)
            }
            .padding(.vertical, 2)
          }
        }
      }
      if !vm.memoryEvents.isEmpty {
        Section("Events") {
          ForEach(vm.memoryEvents) { e in
            Text(e.summary)
              .font(.system(size: 14))
              .foregroundStyle(Color.brandText)
              .padding(.vertical, 2)
          }
        }
      }
      if vm.reflections.isEmpty && vm.profileFacts.isEmpty && vm.memoryEvents.isEmpty {
        ContentUnavailableView(
          "No memories yet",
          systemImage: "brain",
          description: Text("Memories are built from your conversations.")
        )
      }
    }
    .scrollContentBackground(.hidden)
  }
}

// MARK: - Onboarding View

struct OnboardingView: View {
  @EnvironmentObject var vm: JarvisViewModel
  @State private var url   = ""
  @State private var token = ""

  var body: some View {
    ZStack {
      Color.brandBackground.ignoresSafeArea()
      VStack(spacing: 32) {
        Spacer()
        Image("AppIcon")
          .resizable()
          .scaledToFit()
          .frame(width: 80, height: 80)
          .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

        VStack(spacing: 8) {
          Text("Jarvis")
            .font(.system(size: 30, weight: .semibold))
            .foregroundStyle(Color.brandText)
          Text("Your external memory.")
            .font(.system(size: 16))
            .foregroundStyle(Color.brandSubtle)
        }

        VStack(spacing: 12) {
          TextField("Backend URL", text: $url)
            .textContentType(.URL)
            .autocorrectionDisabled()
#if os(iOS)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
#endif
            .padding(14)
            .background(Color.brandSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(Color.brandText)

          SecureField("Auth Token", text: $token)
            .autocorrectionDisabled()
#if os(iOS)
            .textInputAutocapitalization(.never)
#endif
            .padding(14)
            .background(Color.brandSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(Color.brandText)
        }
        .padding(.horizontal, 32)

        Button {
          var s = vm.settings
          s.backendBaseURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
          s.apiAuthToken   = token.trimmingCharacters(in: .whitespacesAndNewlines)
          vm.updateSettings(s)
          vm.completeOnboarding()
        } label: {
          Text("Connect")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Color.brandBackground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
              url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? Color.brandSubtle.opacity(0.3)
                : Color.brandAccent,
              in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
        }
        .disabled(url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .padding(.horizontal, 32)

        Spacer()
      }
    }
  }
}
