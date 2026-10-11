import SwiftUI

/**
 * «Бюджет» для Mac: окно с боковой панелью разделов и кнопками на панели инструментов, внутри — сайт бюджета
 * (тот же, что на сервере), без его шапки и нижней панели. Связь с сайтом — в BudgetWindowModel.
 * Сборка и установка — scripts/mac-install.sh.
 */
@main
struct BudgetMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = BudgetWindowModel()

    var body: some Scene {
        Window("Бюджет", id: "main") {
            ContentView(model: model)
                .frame(minWidth: 760, minHeight: 540)
        }
        .defaultSize(width: 1240, height: 820)
        .commands { BudgetCommands(model: model) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    // Одно окно: закрыли его — приложение завершается, как «Калькулятор».
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/** Разделы сайта (id — как вкладки в src/components/app/App.tsx). */
enum BudgetSection: String, CaseIterable, Identifiable {
    case home, history, plans, goals, analytics, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Главная"
        case .history: "История"
        case .plans: "Регулярные"
        case .goals: "Цели"
        case .analytics: "Аналитика"
        case .settings: "Настройки"
        }
    }

    var symbol: String {
        switch self {
        case .home: "house"
        case .history: "list.bullet"
        case .plans: "arrow.triangle.2.circlepath"
        case .goals: "target"
        case .analytics: "chart.bar"
        case .settings: "gearshape"
        }
    }

    var shortcut: KeyEquivalent {
        KeyEquivalent(Character(String((Self.allCases.firstIndex(of: self) ?? 0) + 1)))
    }
}

struct ContentView: View {
    let model: BudgetWindowModel

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { model.section }, set: { if let section = $0 { model.select(section) } })) {
                ForEach(BudgetSection.allCases) { section in
                    Label(section.title, systemImage: section.symbol).tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 260)
        } detail: {
            WebContainer(webView: model.webView)
                .overlay {
                    if let error = model.loadError {
                        OfflineView(message: error) { model.reload() }
                    }
                }
                .navigationTitle(model.title)
                .navigationSubtitle(model.status)
                .toolbar {
                    ToolbarItemGroup(placement: .primaryAction) {
                        if model.aiAvailable {
                            Button {
                                model.send(["type": "ai"])
                            } label: {
                                Label("AI-помощник", systemImage: "sparkles")
                            }
                            .help("AI-помощник (⌘K)")
                        }
                        Button {
                            model.send(["type": "add"])
                        } label: {
                            Label("Новая операция", systemImage: "plus")
                        }
                        .help("Новая операция (⌘N)")
                    }
                }
        }
    }
}

/** Сервер недоступен, а сайт ещё ни разу не открывался (иначе его покажет офлайн-оболочка). */
private struct OfflineView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Нет связи с сервером", systemImage: "wifi.slash")
        } description: {
            Text(message)
        } actions: {
            Button("Повторить", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

struct BudgetCommands: Commands {
    let model: BudgetWindowModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Новая операция") { model.send(["type": "add"]) }
                .keyboardShortcut("n")
        }
        CommandGroup(replacing: .appSettings) {
            Button("Настройки…") { model.select(.settings) }
                .keyboardShortcut(",")
        }
        CommandMenu("Разделы") {
            ForEach(BudgetSection.allCases) { section in
                Button(section.title) { model.select(section) }
                    .keyboardShortcut(section.shortcut)
            }
            Divider()
            Button("AI-помощник") { model.send(["type": "ai"]) }
                .keyboardShortcut("k")
                .disabled(!model.aiAvailable)
        }
        CommandGroup(after: .toolbar) {
            Button("Обновить") { model.reload() }
                .keyboardShortcut("r")
            Divider()
            Button("Крупнее") { model.zoom(by: 0.1) }
                .keyboardShortcut("+")
            Button("Мельче") { model.zoom(by: -0.1) }
                .keyboardShortcut("-")
            Button("Обычный размер") { model.zoom(by: 0) }
                .keyboardShortcut("0")
            Divider()
        }
    }
}
