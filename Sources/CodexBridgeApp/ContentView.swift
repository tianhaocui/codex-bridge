import SwiftUI
import AppKit

private struct LaunchOverrides {
    let projectAPath: String?
    let projectBPath: String?
    let sessionA: String?
    let sessionB: String?

    static func fromCommandLine() -> LaunchOverrides {
        let args = Array(CommandLine.arguments.dropFirst())
        var result = LaunchOverrides(projectAPath: nil, projectBPath: nil, sessionA: nil, sessionB: nil)
        var idx = 0
        while idx < args.count {
            let key = args[idx]
            guard idx + 1 < args.count else { break }
            let value = args[idx + 1]
            switch key {
            case "--project-a":
                result = LaunchOverrides(projectAPath: value, projectBPath: result.projectBPath, sessionA: result.sessionA, sessionB: result.sessionB)
                idx += 2
            case "--project-b":
                result = LaunchOverrides(projectAPath: result.projectAPath, projectBPath: value, sessionA: result.sessionA, sessionB: result.sessionB)
                idx += 2
            case "--session-a":
                result = LaunchOverrides(projectAPath: result.projectAPath, projectBPath: result.projectBPath, sessionA: value, sessionB: result.sessionB)
                idx += 2
            case "--session-b":
                result = LaunchOverrides(projectAPath: result.projectAPath, projectBPath: result.projectBPath, sessionA: result.sessionA, sessionB: value)
                idx += 2
            default:
                idx += 1
            }
        }
        return result
    }
}

private enum VSCodePalette {
    static let window = Color(dynamicDark: 0x1E1E1E, light: 0xF3F4F6)
    static let workbench = Color(dynamicDark: 0x252526, light: 0xECEEF2)
    static let activityBar = Color(dynamicDark: 0x333333, light: 0xE1E5ED)
    static let titleBar = Color(dynamicDark: 0x2B2B2B, light: 0xE8ECF3)
    static let panel = Color(dynamicDark: 0x2D2D30, light: 0xFFFFFF)
    static let elevated = Color(dynamicDark: 0x333337, light: 0xE5E8EF)
    static let input = Color(dynamicDark: 0x3C3C3C, light: 0xF7F8FB)
    static let border = Color(dynamicDark: 0x3F3F46, light: 0xCDD3DF)
    static let textPrimary = Color(dynamicDark: 0xD4D4D4, light: 0x1F2937)
    static let textMuted = Color(dynamicDark: 0x9DA0A5, light: 0x6B7280)
    static let accent = Color(dynamicDark: 0x007ACC, light: 0x0969DA)
    static let success = Color(dynamicDark: 0x89D185, light: 0x1B8A5A)
    static let warning = Color(dynamicDark: 0xD7BA7D, light: 0x996515)
    static let statusBar = Color(dynamicDark: 0x007ACC, light: 0x0969DA)
    static let textOnAccent = Color(dynamicDark: 0xF8FAFC, light: 0xFFFFFF)
}

private extension Color {
    init(hex: Int, alpha: Double = 1.0) {
        let red = Double((hex >> 16) & 0xFF) / 255.0
        let green = Double((hex >> 8) & 0xFF) / 255.0
        let blue = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }

    init(dynamicDark darkHex: Int, light lightHex: Int, alpha: Double = 1.0) {
        let dynamic = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hex = isDark ? darkHex : lightHex
            let red = CGFloat((hex >> 16) & 0xFF) / 255.0
            let green = CGFloat((hex >> 8) & 0xFF) / 255.0
            let blue = CGFloat(hex & 0xFF) / 255.0
            return NSColor(
                calibratedRed: red,
                green: green,
                blue: blue,
                alpha: alpha
            )
        }
        self.init(nsColor: dynamic)
    }
}

private struct VSCodePanel<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title.uppercased())
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(VSCodePalette.textMuted)
                Spacer()
            }

            content
        }
        .padding(12)
        .background(VSCodePalette.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(VSCodePalette.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct VSCodeButtonStyle: ButtonStyle {
    let isPrimary: Bool
    let disabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(isPrimary ? .white : VSCodePalette.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(backgroundColor(pressed: configuration.isPressed))
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(VSCodePalette.border.opacity(isPrimary ? 0 : 1), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func backgroundColor(pressed: Bool) -> Color {
        if disabled { return VSCodePalette.elevated.opacity(0.45) }
        if isPrimary { return pressed ? VSCodePalette.accent.opacity(0.8) : VSCodePalette.accent }
        return pressed ? VSCodePalette.elevated.opacity(0.9) : VSCodePalette.elevated
    }
}

private struct PanelResizeHandle: View {
    @Binding var height: CGFloat
    let minHeight: CGFloat
    let maxHeight: CGFloat
    @State private var dragStartHeight: CGFloat?

    var body: some View {
        Capsule(style: .circular)
            .fill(VSCodePalette.border.opacity(0.9))
            .frame(width: 64, height: 6)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragStartHeight == nil {
                            dragStartHeight = height
                        }
                        let base = dragStartHeight ?? height
                        height = min(max(base + value.translation.height, minHeight), maxHeight)
                    }
                    .onEnded { _ in
                        dragStartHeight = nil
                    }
            )
    }
}

private struct ResizablePanelModifier: ViewModifier {
    let height: CGFloat
    let binding: Binding<CGFloat>
    let minHeight: CGFloat
    let maxHeight: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(height: height)
            .overlay(alignment: .bottom) {
                PanelResizeHandle(
                    height: binding,
                    minHeight: minHeight,
                    maxHeight: maxHeight
                )
                .offset(y: 10)
            }
            .padding(.bottom, 10)
    }
}

private struct MarkdownMessageText: View {
    let text: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            Text(attributed)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(VSCodePalette.textPrimary)
        } else {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(VSCodePalette.textPrimary)
        }
    }
}

struct ContentView: View {
    @StateObject private var engine = BridgeEngine()
    private let launchOverrides = LaunchOverrides.fromCommandLine()
    @AppStorage("bridge.projectAPath") private var storedProjectAPath = ""
    @AppStorage("bridge.projectBPath") private var storedProjectBPath = ""
    @AppStorage("bridge.sessionA") private var storedSessionA = ""
    @AppStorage("bridge.sessionB") private var storedSessionB = ""

    @State private var projectAPath = ""
    @State private var projectBPath = ""
    @State private var sessionA = ""
    @State private var sessionB = ""

    @State private var draftMessage = ""

    @State private var projectOptions: [String] = []
    @State private var sessionOptions: [SessionOption] = []
    @State private var loadStatus = "尚未加载 ~/.codex 配置"
    @State private var selectedDiffSide: BridgeEngine.Side = .a
    @State private var selectedDiffFileA: String = ""
    @State private var selectedDiffFileB: String = ""
    @State private var selectedActivity: ActivityItem = .explorer
    @State private var selectedSnapshotID = ""
    @State private var diffOnlyAdditions = false
    @State private var diffOnlyDeletions = false
    @State private var diffFileExtension = ""
    @State private var diffKeyword = ""
    @AppStorage("bridge.chatControlExpanded") private var chatControlExpanded = false
    @AppStorage("bridge.panel.settingsHeight") private var settingsPanelHeightStored = 220.0
    @AppStorage("bridge.panel.chatHeight") private var chatPanelHeightStored = 620.0
    @AppStorage("bridge.panel.diffHeight") private var diffPanelHeightStored = 400.0
    @AppStorage("bridge.panel.boardHeight") private var boardPanelHeightStored = 300.0
    @AppStorage("bridge.panel.snapshotHeight") private var snapshotPanelHeightStored = 240.0
    @AppStorage("bridge.themeMode") private var themeModeRaw = ThemeMode.system.rawValue

    private var sessionsForA: [SessionOption] { filteredSessions(for: projectAPath) }
    private var sessionsForB: [SessionOption] { filteredSessions(for: projectBPath) }
    private var canSelectSessionA: Bool { !projectAPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSelectSessionB: Bool { !projectBPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var connectedProjectCount: Int {
        [projectAPath, projectBPath]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .count
    }
    private var activeSessionCount: Int {
        [sessionA, sessionB]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .count
    }
    private var diffFilterOptions: BridgeEngine.DiffFilterOptions {
        .init(
            additionsOnly: diffOnlyAdditions,
            deletionsOnly: diffOnlyDeletions,
            fileExtension: diffFileExtension,
            keyword: diffKeyword
        )
    }
    private var settingsPanelHeight: CGFloat { panelHeight(settingsPanelHeightStored, minHeight: 170, maxHeight: 460) }
    private var chatPanelHeight: CGFloat { panelHeight(chatPanelHeightStored, minHeight: 440, maxHeight: 980) }
    private var diffPanelHeight: CGFloat { panelHeight(diffPanelHeightStored, minHeight: 320, maxHeight: 780) }
    private var boardPanelHeight: CGFloat { panelHeight(boardPanelHeightStored, minHeight: 180, maxHeight: 520) }
    private var snapshotPanelHeight: CGFloat { panelHeight(snapshotPanelHeightStored, minHeight: 170, maxHeight: 440) }
    private var displayedDiffFiles: [String] {
        engine.filteredFiles(for: selectedDiffSide, fileExtension: diffFileExtension)
    }
    private var themeMode: ThemeMode {
        get { ThemeMode(rawValue: themeModeRaw) ?? .system }
        set { themeModeRaw = newValue.rawValue }
    }
    private var preferredColorScheme: ColorScheme? {
        switch themeMode {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            activityBar

            Divider()
                .overlay(VSCodePalette.border)

            VStack(spacing: 0) {
                workbenchHeader

                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 12) {
                            resizablePanel(
                                settingsBar.id(SectionAnchor.explorer),
                                height: settingsPanelHeight,
                                binding: panelHeightBinding($settingsPanelHeightStored, minHeight: 170, maxHeight: 460),
                                minHeight: 170,
                                maxHeight: 460
                            )
                            resizablePanel(
                                unifiedConversation.id(SectionAnchor.chat),
                                height: chatPanelHeight,
                                binding: panelHeightBinding($chatPanelHeightStored, minHeight: 440, maxHeight: 980),
                                minHeight: 440,
                                maxHeight: 980
                            )
                            resizablePanel(
                                diffPanel.id(SectionAnchor.diff),
                                height: diffPanelHeight,
                                binding: panelHeightBinding($diffPanelHeightStored, minHeight: 320, maxHeight: 780),
                                minHeight: 320,
                                maxHeight: 780
                            )
                            footerActions
                        }
                        .padding(12)
                    }
                    .background(VSCodePalette.workbench)
                    .onAppear {
                        scrollToSection(selectedActivity, with: proxy, animated: false)
                    }
                    .onChange(of: selectedActivity) { _, activity in
                        scrollToSection(activity, with: proxy, animated: true)
                    }
                }

                statusBar
            }

            Divider()
                .overlay(VSCodePalette.border)

            rightSidebar
        }
        .frame(minWidth: 1320, minHeight: 820)
        .background(VSCodePalette.window)
        .preferredColorScheme(preferredColorScheme)
        .onAppear {
            if let launchA = launchOverrides.projectAPath,
               !launchA.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                projectAPath = launchA
            } else if projectAPath.isEmpty {
                projectAPath = storedProjectAPath
            }

            if let launchB = launchOverrides.projectBPath,
               !launchB.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                projectBPath = launchB
            } else if projectBPath.isEmpty {
                projectBPath = storedProjectBPath
            }

            if let launchSessionA = launchOverrides.sessionA,
               !launchSessionA.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sessionA = launchSessionA
            } else if sessionA.isEmpty {
                sessionA = storedSessionA
            }

            if let launchSessionB = launchOverrides.sessionB,
               !launchSessionB.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sessionB = launchSessionB
            } else if sessionB.isEmpty {
                sessionB = storedSessionB
            }
            loadCodexOptions()
        }
        .onChange(of: projectAPath) { _, newValue in
            storedProjectAPath = newValue
            if newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sessionA = ""
            }
        }
        .onChange(of: projectBPath) { _, newValue in
            storedProjectBPath = newValue
            if newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sessionB = ""
            }
        }
        .onChange(of: sessionA) { _, newValue in
            storedSessionA = newValue
        }
        .onChange(of: sessionB) { _, newValue in
            storedSessionB = newValue
        }
        .onChange(of: engine.diffStateA.files) { _, _ in
            if !selectedDiffFileA.isEmpty, !displayedDiffFiles.contains(selectedDiffFileA) {
                selectedDiffFileA = ""
            }
        }
        .onChange(of: engine.diffStateB.files) { _, _ in
            if !selectedDiffFileB.isEmpty, !displayedDiffFiles.contains(selectedDiffFileB) {
                selectedDiffFileB = ""
            }
        }
        .onChange(of: diffFileExtension) { _, _ in
            if !selectedDiffFileA.isEmpty, !displayedDiffFiles.contains(selectedDiffFileA) {
                selectedDiffFileA = ""
            }
            if !selectedDiffFileB.isEmpty, !displayedDiffFiles.contains(selectedDiffFileB) {
                selectedDiffFileB = ""
            }
        }
    }

    private enum ThemeMode: String, CaseIterable, Identifiable {
        case system
        case light
        case dark

        var id: String { rawValue }
        var label: String {
            switch self {
            case .system: return "系统"
            case .light: return "白天"
            case .dark: return "夜间"
            }
        }
    }

    private enum ActivityItem: String, CaseIterable, Identifiable {
        case explorer
        case chat
        case diff

        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .explorer: return "folder"
            case .chat: return "ellipsis.bubble"
            case .diff: return "square.split.2x1"
            }
        }
    }

    private enum SectionAnchor: String, Hashable {
        case explorer
        case chat
        case diff
    }

    private var activityBar: some View {
        VStack(spacing: 14) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(VSCodePalette.accent)
                .padding(.top, 12)

            ForEach(ActivityItem.allCases) { item in
                Button {
                    selectedActivity = item
                } label: {
                    activityIcon(systemName: item.symbol, active: selectedActivity == item)
                }
                .buttonStyle(.plain)
                .help(item.rawValue.capitalized)
            }

            Spacer()
        }
        .frame(width: 50)
        .background(VSCodePalette.activityBar)
    }

    private func scrollToSection(
        _ activity: ActivityItem,
        with proxy: ScrollViewProxy,
        animated: Bool
    ) {
        let anchor: SectionAnchor
        switch activity {
        case .explorer:
            anchor = .explorer
        case .chat:
            anchor = .chat
        case .diff:
            anchor = .diff
        }

        let runScroll = {
            proxy.scrollTo(anchor, anchor: .top)
        }
        if animated {
            withAnimation(.easeInOut(duration: 0.2)) {
                runScroll()
            }
        } else {
            runScroll()
        }
    }

    private func activityIcon(systemName: String, active: Bool) -> some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(active ? VSCodePalette.accent : .clear)
                .frame(width: 2, height: 20)

            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 24, height: 24)
                .foregroundStyle(active ? VSCodePalette.textPrimary : VSCodePalette.textMuted)
                .padding(.leading, 2)
        }
        .frame(width: 30, alignment: .leading)
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            statusBadge(systemName: "link", text: "已连接项目 \(connectedProjectCount)/2")
            statusBadge(systemName: "clock.arrow.circlepath", text: "会话 \(activeSessionCount) 个")
            statusBadge(systemName: "arrow.triangle.2.circlepath", text: "Relay \(engine.relayTurnCount)")
            statusBadge(
                systemName: engine.autoRelayEnabled ? "repeat.circle.fill" : "repeat.circle",
                text: engine.autoRelayEnabled ? "自动互发已开启" : "自动互发已关闭"
            )
            statusBadge(systemName: engine.isSendingA ? "a.circle.fill" : "a.circle", text: engine.isSendingA ? "A忙碌" : "A空闲")
            statusBadge(systemName: engine.isSendingB ? "b.circle.fill" : "b.circle", text: engine.isSendingB ? "B忙碌" : "B空闲")

            Spacer()

            if !engine.lastErrorA.isEmpty {
                Text("A错: \(engine.lastErrorA)")
                    .lineLimit(1)
                    .font(.system(size: 10, design: .monospaced))
            } else if let success = engine.lastSuccessA {
                Text("A成: \(timeString(success))")
                    .font(.system(size: 10, design: .monospaced))
            }
            if !engine.lastErrorB.isEmpty {
                Text("B错: \(engine.lastErrorB)")
                    .lineLimit(1)
                    .font(.system(size: 10, design: .monospaced))
            } else if let success = engine.lastSuccessB {
                Text("B成: \(timeString(success))")
                    .font(.system(size: 10, design: .monospaced))
            }
            Text("Turn A: \(engine.diffStateA.turnId.isEmpty ? "-" : String(engine.diffStateA.turnId.prefix(8)))")
                .font(.system(size: 11, design: .monospaced))
            Text("Turn B: \(engine.diffStateB.turnId.isEmpty ? "-" : String(engine.diffStateB.turnId.prefix(8)))")
                .font(.system(size: 11, design: .monospaced))
        }
        .foregroundStyle(VSCodePalette.textOnAccent.opacity(0.95))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(VSCodePalette.statusBar)
    }

    private func statusBadge(systemName: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemName)
            .font(.system(size: 13))
            Text(text)
                .font(.system(size: 11, weight: .semibold))
        }
    }

    private var workbenchHeader: some View {
        HStack(spacing: 10) {
            Text("CODEX BRIDGE")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(VSCodePalette.textMuted)

            Spacer()

            Picker("主题", selection: Binding(
                get: { ThemeMode(rawValue: themeModeRaw) ?? .system },
                set: { themeModeRaw = $0.rawValue }
            )) {
                ForEach(ThemeMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 210)

            Text(engine.autoRelayEnabled ? "AUTO RELAY: ON" : "AUTO RELAY: OFF")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(engine.autoRelayEnabled ? VSCodePalette.accent.opacity(0.22) : VSCodePalette.elevated)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(VSCodePalette.titleBar)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(VSCodePalette.border), alignment: .bottom)
    }

    private var currentDiffState: BridgeEngine.TurnDiffState {
        engine.diffState(for: selectedDiffSide)
    }

    private var selectedDiffFile: String? {
        switch selectedDiffSide {
        case .a: return selectedDiffFileA.isEmpty ? nil : selectedDiffFileA
        case .b: return selectedDiffFileB.isEmpty ? nil : selectedDiffFileB
        }
    }

    private var diffPanel: some View {
        VSCodePanel(title: "改动面板") {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    Picker("来源", selection: $selectedDiffSide) {
                        Text("A").tag(BridgeEngine.Side.a)
                        Text("B").tag(BridgeEngine.Side.b)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 170)

                    Text("Turn: \(currentDiffState.turnId.isEmpty ? "-" : String(currentDiffState.turnId.prefix(8)))")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(VSCodePalette.textMuted)

                    Spacer()

                    Button("复制 Diff") {
                        copyText(engine.filteredDiffText(for: selectedDiffSide, file: selectedDiffFile, options: diffFilterOptions))
                    }
                    .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))
                }

                HStack(spacing: 8) {
                    Toggle("仅新增(+)", isOn: $diffOnlyAdditions)
                        .toggleStyle(.switch)
                    Toggle("仅删除(-)", isOn: $diffOnlyDeletions)
                        .toggleStyle(.switch)
                    TextField("扩展名过滤（如 .swift）", text: $diffFileExtension)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(VSCodePalette.input)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(VSCodePalette.border, lineWidth: 1)
                        )
                        .frame(width: 180)
                    TextField("关键字过滤", text: $diffKeyword)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(VSCodePalette.input)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(VSCodePalette.border, lineWidth: 1)
                        )
                }

                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("文件")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(VSCodePalette.textMuted)

                        List(selection: bindingForSelectedDiffFile()) {
                            Text("全部文件")
                                .tag("")
                                .foregroundStyle(VSCodePalette.textPrimary)
                            ForEach(displayedDiffFiles, id: \.self) { file in
                                Text(file)
                                    .foregroundStyle(VSCodePalette.textPrimary)
                                    .tag(file)
                            }
                        }
                        .listStyle(.plain)
                        .frame(minWidth: 300, minHeight: 210, maxHeight: 260)
                        .scrollContentBackground(.hidden)
                        .background(VSCodePalette.input)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(VSCodePalette.border, lineWidth: 1)
                        )
                    }

                    ScrollView {
                        Text(engine.filteredDiffText(for: selectedDiffSide, file: selectedDiffFile, options: diffFilterOptions))
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(VSCodePalette.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(10)
                    }
                    .frame(minHeight: 250)
                    .background(VSCodePalette.input)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(VSCodePalette.border, lineWidth: 1)
                    )
                }
            }
        }
    }

    private var settingsBar: some View {
        VSCodePanel(title: "连接设置") {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Button("刷新 ~/.codex") { loadCodexOptions() }
                        .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))
                    Text(loadStatus)
                        .font(.system(size: 11))
                        .foregroundStyle(VSCodePalette.textMuted)
                    Spacer()
                }

                ViewThatFits(in: .horizontal) {
                    VStack(spacing: 8) {
                        HStack {
                            connectionRow(
                                label: "A项目",
                                placeholder: "A项目路径",
                                text: $projectAPath,
                                menuDisabled: false
                            ) {
                                ForEach(projectOptions, id: \.self) { path in
                                    Button(path) { projectAPath = path }
                                }
                            }
                            connectionRow(
                                label: "A会话",
                                placeholder: canSelectSessionA ? "A会话ID（可空=新会话）" : "请先选择A项目",
                                text: $sessionA,
                                menuDisabled: !canSelectSessionA
                            ) {
                                if !canSelectSessionA {
                                    Text("请先选择A项目").disabled(true)
                                } else {
                                    Button("新会话（留空）") { sessionA = "" }
                                    ForEach(sessionsForA) { option in
                                        Button(option.displayLabel) { sessionA = option.id }
                                    }
                                }
                            }
                        }
                        HStack {
                            connectionRow(
                                label: "B项目",
                                placeholder: "B项目路径",
                                text: $projectBPath,
                                menuDisabled: false
                            ) {
                                ForEach(projectOptions, id: \.self) { path in
                                    Button(path) { projectBPath = path }
                                }
                            }
                            connectionRow(
                                label: "B会话",
                                placeholder: canSelectSessionB ? "B会话ID（可空=新会话）" : "请先选择B项目",
                                text: $sessionB,
                                menuDisabled: !canSelectSessionB
                            ) {
                                if !canSelectSessionB {
                                    Text("请先选择B项目").disabled(true)
                                } else {
                                    Button("新会话（留空）") { sessionB = "" }
                                    ForEach(sessionsForB) { option in
                                        Button(option.displayLabel) { sessionB = option.id }
                                    }
                                }
                            }
                        }
                    }

                    VStack(spacing: 8) {
                        connectionRow(
                            label: "A项目",
                            placeholder: "A项目路径",
                            text: $projectAPath,
                            menuDisabled: false
                        ) {
                            ForEach(projectOptions, id: \.self) { path in
                                Button(path) { projectAPath = path }
                            }
                        }
                        connectionRow(
                            label: "A会话",
                            placeholder: canSelectSessionA ? "A会话ID（可空=新会话）" : "请先选择A项目",
                            text: $sessionA,
                            menuDisabled: !canSelectSessionA
                        ) {
                            if !canSelectSessionA {
                                Text("请先选择A项目").disabled(true)
                            } else {
                                Button("新会话（留空）") { sessionA = "" }
                                ForEach(sessionsForA) { option in
                                    Button(option.displayLabel) { sessionA = option.id }
                                }
                            }
                        }
                        connectionRow(
                            label: "B项目",
                            placeholder: "B项目路径",
                            text: $projectBPath,
                            menuDisabled: false
                        ) {
                            ForEach(projectOptions, id: \.self) { path in
                                Button(path) { projectBPath = path }
                            }
                        }
                        connectionRow(
                            label: "B会话",
                            placeholder: canSelectSessionB ? "B会话ID（可空=新会话）" : "请先选择B项目",
                            text: $sessionB,
                            menuDisabled: !canSelectSessionB
                        ) {
                            if !canSelectSessionB {
                                Text("请先选择B项目").disabled(true)
                            } else {
                                Button("新会话（留空）") { sessionB = "" }
                                ForEach(sessionsForB) { option in
                                    Button(option.displayLabel) { sessionB = option.id }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var unifiedConversation: some View {
        VSCodePanel(title: "统一对话框") {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        chatControlExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: chatControlExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                        Text("对话控制")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        Spacer()
                    }
                    .foregroundStyle(VSCodePalette.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(VSCodePalette.input.opacity(0.7))
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(VSCodePalette.border.opacity(0.8), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)

                if chatControlExpanded {
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle("开启自动互发（A回复自动给B，B回复自动给A）", isOn: $engine.autoRelayEnabled)
                            .toggleStyle(.switch)
                        Toggle("检测到阶段完成后自动停止互发", isOn: $engine.stopOnStageDone)
                            .toggleStyle(.switch)
                    }
                    .padding(8)
                    .background(VSCodePalette.input)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(VSCodePalette.border, lineWidth: 1)
                    )
                    .tint(VSCodePalette.accent)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(engine.chatItems) { item in
                                messageBubble(item: item)
                                    .id(item.id)
                            }
                        }
                        .padding(10)
                    }
                    .frame(maxHeight: .infinity)
                    .background(VSCodePalette.input)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(VSCodePalette.border, lineWidth: 1)
                    )

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top, spacing: 8) {
                            EnterSendTextEditor(text: $draftMessage, minHeight: 64) {
                                sendToA()
                            }
                            .frame(height: 64)
                            .background(VSCodePalette.input)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(VSCodePalette.border, lineWidth: 1)
                            )

                            Button("发给A") { sendToA() }
                                .buttonStyle(VSCodeButtonStyle(isPrimary: true, disabled: false))
                            Button("发给B") { sendToB() }
                                .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))
                            Button("同时发送") { sendToBoth() }
                                .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))
                        }

                        HStack {
                            Button("中断对话") { engine.interruptConversation() }
                                .buttonStyle(
                                    VSCodeButtonStyle(
                                        isPrimary: false,
                                        disabled: !engine.isSendingA && !engine.isSendingB && !engine.autoRelayEnabled
                                    )
                                )
                                .disabled(!engine.isSendingA && !engine.isSendingB && !engine.autoRelayEnabled)
                            Spacer()
                            Text("Enter 发送给A / Shift+Enter 换行")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(VSCodePalette.textMuted)
                        }
                    }
                    .padding(8)
                    .background(VSCodePalette.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(VSCodePalette.border, lineWidth: 1)
                    )
                    .onChange(of: engine.chatItems.count) { _, _ in
                        guard let last = engine.chatItems.last else { return }
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                    .onChange(of: engine.chatItems.last?.text ?? "") { _, _ in
                        guard let last = engine.chatItems.last else { return }
                        withAnimation(.linear(duration: 0.08)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private var footerActions: some View {
        HStack {
            Button("复制全部对话") {
                copyText(fullTranscript())
            }
            .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))

            Button("清空记录") { engine.clear() }
                .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: false))
            Spacer()
        }
    }

    private var rightSidebar: some View {
        VStack(spacing: 10) {
            VSCodePanel(title: "结构化任务看板") {
                taskSection(title: "TODO", items: engine.taskBoard.todo, color: VSCodePalette.accent)
                taskSection(title: "IN-PROGRESS", items: engine.taskBoard.inProgress, color: VSCodePalette.warning)
                taskSection(title: "DONE", items: engine.taskBoard.done, color: VSCodePalette.success)
                taskSection(title: "BLOCKER", items: engine.taskBoard.blocker, color: Color.red.opacity(0.8))
            }
            .modifier(
                ResizablePanelModifier(
                    height: boardPanelHeight,
                    binding: panelHeightBinding($boardPanelHeightStored, minHeight: 180, maxHeight: 520),
                    minHeight: 180,
                    maxHeight: 520
                )
            )

            VSCodePanel(title: "回放与快照") {
                Text("自动保存路径：~/.codex-bridge/logs")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(VSCodePalette.textMuted)

                Picker("快照", selection: $selectedSnapshotID) {
                    Text("选择快照").tag("")
                    ForEach(engine.historySnapshots) { item in
                        Text("\(formatSnapshotDate(item.createdAt)) · \(item.summary)")
                            .lineLimit(1)
                            .tag(item.id)
                    }
                }
                .pickerStyle(.menu)

                HStack {
                    Button("回放选中快照") {
                        guard !selectedSnapshotID.isEmpty else { return }
                        if let message = engine.replaySnapshot(id: selectedSnapshotID) {
                            loadStatus = message
                        }
                    }
                    .buttonStyle(VSCodeButtonStyle(isPrimary: false, disabled: selectedSnapshotID.isEmpty))
                    .disabled(selectedSnapshotID.isEmpty)
                    Spacer()
                    Text("共 \(engine.historySnapshots.count) 条")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(VSCodePalette.textMuted)
                }
            }
            .modifier(
                ResizablePanelModifier(
                    height: snapshotPanelHeight,
                    binding: panelHeightBinding($snapshotPanelHeightStored, minHeight: 170, maxHeight: 440),
                    minHeight: 170,
                    maxHeight: 440
                )
            )

            Spacer()
        }
        .padding(10)
        .frame(width: 320)
        .background(VSCodePalette.workbench)
    }

    private func messageBubble(item: BridgeEngine.ChatItem) -> some View {
        let timeText = timeString(item.time)
        let style = speakerStyle(for: item)
        let reasoningText = reasoningText(for: item)

        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(style.title)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(style.titleColor)
                Spacer()
                Text(timeText)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(VSCodePalette.textMuted)
            }

            if !reasoningText.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Thinking")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(VSCodePalette.textMuted)
                    ScrollView {
                        Text(reasoningText)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(VSCodePalette.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 120)
                }
                .padding(8)
                .background(VSCodePalette.window.opacity(0.48))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(VSCodePalette.border.opacity(0.75), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            MarkdownMessageText(text: item.text.isEmpty ? "(生成中...)" : item.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(10)
        .background(style.background)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(style.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func reasoningText(for item: BridgeEngine.ChatItem) -> String {
        guard item.role == .assistant,
              let side = item.side,
              let turnId = item.turnId,
              !turnId.isEmpty else {
            return ""
        }
        return engine.reasoningText(side: side, turnId: turnId)
    }

    private func speakerStyle(for item: BridgeEngine.ChatItem) -> (title: String, titleColor: Color, background: Color, border: Color) {
        switch item.role {
        case .user:
            let target = item.side?.rawValue ?? "?"
            return (
                title: "你 -> \(target)",
                titleColor: VSCodePalette.accent,
                background: VSCodePalette.accent.opacity(0.12),
                border: VSCodePalette.accent.opacity(0.4)
            )
        case .assistant:
            if item.side == .a {
                return (
                    title: "A",
                    titleColor: VSCodePalette.success,
                    background: VSCodePalette.success.opacity(0.12),
                    border: VSCodePalette.success.opacity(0.42)
                )
            }
            return (
                title: "B",
                titleColor: VSCodePalette.warning,
                background: VSCodePalette.warning.opacity(0.14),
                border: VSCodePalette.warning.opacity(0.42)
            )
        case .system:
            return (
                title: "系统",
                titleColor: VSCodePalette.textMuted,
                background: VSCodePalette.elevated.opacity(0.6),
                border: VSCodePalette.border
            )
        }
    }

    private var channelConfig: BridgeEngine.ChannelConfig {
        .init(
            aProjectPath: projectAPath,
            aSessionID: sessionA,
            bProjectPath: projectBPath,
            bSessionID: sessionB
        )
    }

    private func sendToA() {
        let msg = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        draftMessage = ""
        engine.sendToA(message: msg, config: channelConfig)
    }

    private func sendToB() {
        let msg = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        draftMessage = ""
        engine.sendToB(message: msg, config: channelConfig)
    }

    private func sendToBoth() {
        let msg = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        draftMessage = ""
        engine.sendToA(message: msg, config: channelConfig)
        engine.sendToB(message: msg, config: channelConfig)
    }

    private func loadCodexOptions() {
        do {
            let options = try CodexConfigSource.loadFromHomeCodex()
            projectOptions = options.projects
            sessionOptions = options.sessions
            loadStatus = "已加载项目 \(projectOptions.count) 个，会话 \(sessionOptions.count) 个"
        } catch {
            loadStatus = "加载失败: \(error.localizedDescription)"
        }
    }

    private func filteredSessions(for projectPath: String) -> [SessionOption] {
        let target = projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return sessionOptions }

        return sessionOptions.filter { option in
            guard let cwd = option.cwd, !cwd.isEmpty else { return false }
            if cwd.hasPrefix(target) { return true }
            return basenameMatch(projectPath: target, sessionCwd: cwd)
        }
    }

    private func basenameMatch(projectPath: String, sessionCwd: String) -> Bool {
        let projectName = URL(fileURLWithPath: projectPath).lastPathComponent
        guard !projectName.isEmpty else { return false }

        let cwdURL = URL(fileURLWithPath: sessionCwd)
        if cwdURL.lastPathComponent == projectName { return true }

        let parts = sessionCwd.split(separator: "/")
        if let idx = parts.firstIndex(of: ".codex"), idx + 2 < parts.count,
           parts[idx + 1] == "worktrees" {
            return String(parts[idx + 2]) == projectName
        }
        return false
    }

    private func copyText(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    private func fullTranscript() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return engine.chatItems.map { item in
            let t = formatter.string(from: item.time)
            switch item.role {
            case .user:
                let target = item.side?.rawValue ?? "?"
                return "[\(t)] 你 -> \(target): \(item.text)"
            case .assistant:
                let who = item.side?.rawValue ?? "?"
                return "[\(t)] \(who): \(item.text)"
            case .system:
                return "[\(t)] 系统: \(item.text)"
            }
        }.joined(separator: "\n")
    }

    private func timeString(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }

    private func bindingForSelectedDiffFile() -> Binding<String> {
        switch selectedDiffSide {
        case .a:
            return $selectedDiffFileA
        case .b:
            return $selectedDiffFileB
        }
    }

    private func taskSection(title: String, items: [String], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(title) (\(items.count))")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color)

            if items.isEmpty {
                Text("暂无")
                    .font(.system(size: 11))
                    .foregroundStyle(VSCodePalette.textMuted)
            } else {
                ForEach(items.prefix(6), id: \.self) { item in
                    Text("• \(item)")
                        .font(.system(size: 11))
                        .foregroundStyle(VSCodePalette.textPrimary)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }

    private func formatSnapshotDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm:ss"
        return formatter.string(from: date)
    }

    private func resizablePanel<Panel: View>(
        _ panel: Panel,
        height: CGFloat,
        binding: Binding<CGFloat>,
        minHeight: CGFloat,
        maxHeight: CGFloat
    ) -> some View {
        panel.modifier(
            ResizablePanelModifier(
                height: height,
                binding: binding,
                minHeight: minHeight,
                maxHeight: maxHeight
            )
        )
    }

    private func panelHeight(_ raw: Double, minHeight: CGFloat, maxHeight: CGFloat) -> CGFloat {
        CGFloat(Swift.min(Swift.max(CGFloat(raw), minHeight), maxHeight))
    }

    private func panelHeightBinding(
        _ stored: Binding<Double>,
        minHeight: CGFloat,
        maxHeight: CGFloat
    ) -> Binding<CGFloat> {
        Binding<CGFloat>(
            get: { panelHeight(stored.wrappedValue, minHeight: minHeight, maxHeight: maxHeight) },
            set: { newValue in
                let clamped = Swift.min(Swift.max(newValue, minHeight), maxHeight)
                stored.wrappedValue = Double(clamped)
            }
        )
    }

    private func connectionRow<MenuContent: View>(
        label: String,
        placeholder: String,
        text: Binding<String>,
        menuDisabled: Bool,
        @ViewBuilder menuContent: () -> MenuContent
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(VSCodePalette.textMuted)
                .frame(width: 52, alignment: .leading)

            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 12, design: .monospaced))
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                .background(VSCodePalette.input)
                .foregroundStyle(VSCodePalette.textPrimary)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(VSCodePalette.border, lineWidth: 1)
                )
                .disabled(menuDisabled && label.contains("会话"))
                .frame(minWidth: 230)
                .layoutPriority(1)

            Menu("选择") {
                menuContent()
            }
            .menuStyle(.borderlessButton)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .foregroundStyle(VSCodePalette.textPrimary)
            .background(VSCodePalette.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .disabled(menuDisabled)
            .frame(width: 64, alignment: .leading)
        }
    }
}
