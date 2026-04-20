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
      } else {
        OnboardingView()
          .environmentObject(vm)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:     vm.appDidBecomeActive()
      case .background: vm.appDidEnterBackground()
      default: break
      }
    }
  }
}
