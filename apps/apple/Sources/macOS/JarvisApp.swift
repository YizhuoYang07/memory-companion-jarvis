import SwiftUI

@main
struct JarvisApp: App {
  @StateObject private var vm = JarvisViewModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      if vm.hasCompletedOnboarding {
        ChatView()
          .environmentObject(vm)
          .frame(minWidth: 400, minHeight: 500)
      } else {
        OnboardingView()
          .environmentObject(vm)
          .frame(width: 480, height: 480)
      }
    }
    .windowResizability(.contentMinSize)
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:     vm.appDidBecomeActive()
      case .background: vm.appDidEnterBackground()
      default: break
      }
    }

    // macOS menu commands
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("New Conversation") {
          vm.newConversation()
        }
        .keyboardShortcut("n", modifiers: .command)
      }
    }
  }
}
