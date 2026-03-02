import SwiftUI
import AppKit

@main
struct CodexBridgeApp: App {
    init() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup("Codex Bridge") {
            ContentView()
        }
    }
}
