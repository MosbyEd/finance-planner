import UIKit

/// Связь нативной оболочки с интерфейсом (WebView): команды туда и ответы обратно, состояние интерфейса
/// (вкладка, открыто ли окно) — сюда.
@MainActor
final class AppShell {
    static let shared = AppShell()

    weak var plugin: BudgetNativePlugin?
    weak var root: RootViewController?

    private var pending: [String: CheckedContinuation<JSONValue, Never>] = [:]

    private init() {}

    /// Отправляет команду интерфейсу и ждёт ответа (не дольше 15 секунд).
    func send(_ command: JSONValue) async -> CommandResult {
        guard let plugin, HomeStore.shared.live else {
            return CommandResult(ok: false, error: "Приложение ещё загружается — попробуйте через секунду.")
        }
        let requestId = UUID().uuidString
        let reply = await withCheckedContinuation { continuation in
            pending[requestId] = continuation
            plugin.emitCommand(requestId: requestId, command: command)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                self?.resolve(requestId: requestId, result: .object(["ok": .bool(false), "error": .string("Интерфейс не ответил.")]))
            }
        }
        return CommandResult(reply)
    }

    func resolve(requestId: String, result: JSONValue) {
        pending.removeValue(forKey: requestId)?.resume(returning: result)
    }

    /// Команда с уведомлением о результате: текст ответа, «Отменить» для добавленной операции, ошибка.
    @discardableResult
    func perform(_ command: JSONValue, quiet: Bool = false) async -> CommandResult {
        if command["type"]?.string == "open" { root?.expectWebOverlay() }
        let result = await send(command)
        guard !quiet else { return result }
        if result.ok {
            if let message = result.message {
                let undo = result.txId.map { id in
                    ToastCenter.Action(label: "Отменить") {
                        Task { await AppShell.shared.perform(.command("undo", ["txId": .string(id)])) }
                    }
                }
                ToastCenter.shared.show(message, action: undo)
            }
        } else {
            ToastCenter.shared.show(result.error ?? "Не получилось.", kind: .error)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        return result
    }

    func open(_ overlay: [String: JSONValue]) {
        Task { await perform(.command("open", ["overlay": .object(overlay)])) }
    }

    func setTab(_ tab: String) {
        Task { await perform(.command("tab", ["tab": .string(tab)])) }
    }
}
