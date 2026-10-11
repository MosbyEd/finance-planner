import Capacitor
import Foundation
import FoundationModels
import LocalAuthentication

/// Мост между интерфейсом (JS) и iOS: сессия и сводка для команд Siri, модель Apple Intelligence для помощника.
@objc(BudgetNativePlugin)
public class BudgetNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BudgetNativePlugin"
    public let jsName = "BudgetNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSummary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiRespond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tabBarShow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tabBarUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openShortcuts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addSmsShortcut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openShortcutsApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "siriOrb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shellInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "homeModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "toast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commandResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stateMirror", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smsInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackSmsInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiChatStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiInbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiAck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiChatVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricAuth", returnType: CAPPluginReturnPromise),
    ]

    private var orb: SiriOrbView?

    override public func load() {
        DispatchQueue.main.async { AppShell.shared.plugin = self }
    }

    // MARK: - Нативная оболочка

    /// Есть ли нативная Главная и системная панель вкладок (иначе интерфейс рисует всё сам).
    @objc func shellInfo(_ call: CAPPluginCall) {
        call.resolve(["nativeHome": true])
    }

    /// Модель Главной: посчитана интерфейсом, нативный экран её только рисует.
    @objc func homeModel(_ call: CAPPluginCall) {
        guard let raw = call.getObject("model"),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let model = try? JSONDecoder().decode(HomeModel.self, from: data)
        else {
            call.reject("Некорректная модель Главной")
            return
        }
        DispatchQueue.main.async {
            HomeStore.shared.update(model)
            call.resolve()
        }
    }

    /// Уведомление интерфейса — показывает оболочка, над панелью вкладок.
    @objc func toast(_ call: CAPPluginCall) {
        guard let message = call.getString("message") else {
            call.reject("Нет текста уведомления")
            return
        }
        let id = call.getInt("id") ?? 0
        let kind: ToastCenter.Kind = call.getString("kind") == "error" ? .error : .info
        let actionLabel = call.getString("actionLabel")
        DispatchQueue.main.async {
            let action = actionLabel.map { label in
                ToastCenter.Action(label: label) {
                    Task { await AppShell.shared.perform(.command("toastAction", ["id": .number(Double(id))]), quiet: true) }
                }
            }
            ToastCenter.shared.show(message, kind: kind, action: action)
            call.resolve()
        }
    }

    /// Ответ интерфейса на команду нативного экрана.
    @objc func commandResult(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("Нет requestId")
            return
        }
        let raw = call.getObject("result") ?? [:]
        let result = (try? JSONSerialization.data(withJSONObject: raw))
            .flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .object(["ok": .bool(false)])
        DispatchQueue.main.async {
            AppShell.shared.resolve(requestId: requestId, result: result)
            call.resolve()
        }
    }

    // MARK: - Разбор СМС на телефоне

    /// Копия данных для команд: по ней СМС разбирается на телефоне, даже без сети и при закрытом приложении.
    @objc func stateMirror(_ call: CAPPluginCall) {
        guard let account = call.getString("account"), let stateJson = call.getString("stateJson") else {
            call.reject("Нет аккаунта или данных")
            return
        }
        Task {
            await LocalSms.shared.saveMirror(account: account, stateJson: stateJson)
            call.resolve()
        }
    }

    /// Операции из СМС, разобранные на телефоне, — интерфейс применяет их у себя.
    @objc func smsInbox(_ call: CAPPluginCall) {
        guard let account = call.getString("account") else {
            call.reject("Нет аккаунта")
            return
        }
        Task {
            let items = await LocalSms.shared.inbox(account: account)
            call.resolve([
                "items": items.map { item in
                    ["id": item.id, "ops": item.ops.map { ["opId": $0.opId, "action": $0.action.foundation] }] as [String: Any]
                },
            ])
        }
    }

    @objc func ackSmsInbox(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            await LocalSms.shared.acknowledge(ids)
            call.resolve()
        }
    }

    // MARK: - Face ID

    /// Проверка владельца (Face ID, при неудаче — код телефона): показать спрятанные суммы на счетах.
    @objc func biometricAuth(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Подтвердите, что это вы"
        Task { @MainActor in
            call.resolve(["ok": await Biometric.authenticate(reason: reason)])
        }
    }

    // MARK: - Помощник в фоне

    /// Вопрос помощнику фоновым запросом: ответ дойдёт, даже если свернуть приложение; пока ждём —
    /// Live Activity. Ответ приходит событием aiReply и лежит в aiInbox, пока интерфейс его не заберёт.
    @objc func aiChatStart(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), let threadId = call.getString("threadId"),
              let body = call.getObject("body"), let data = try? JSONSerialization.data(withJSONObject: body)
        else {
            call.reject("Некорректный запрос")
            return
        }
        let question = call.getString("question") ?? ""
        let engine = call.getString("engine") ?? "DeepSeek"
        let expected = call.getInt("expectedSeconds") ?? 10
        DispatchQueue.main.async {
            do {
                try AiRequests.shared.start(
                    requestId: requestId, threadId: threadId, question: question, engine: engine, expectedSeconds: expected, body: data
                )
                call.resolve()
            } catch {
                call.reject("Войдите в аккаунт, чтобы спросить помощника.")
            }
        }
    }

    @objc func aiInbox(_ call: CAPPluginCall) {
        guard let account = BudgetStore.account else {
            call.resolve(["done": [], "running": []])
            return
        }
        Task {
            let inbox = await AiRequests.shared.inbox(account: account)
            call.resolve([
                "done": inbox.done.map { ["requestId": $0.requestId, "threadId": $0.threadId, "status": $0.status, "body": $0.body] as [String: Any] },
                "running": inbox.running.map {
                    ["requestId": $0.requestId, "threadId": $0.threadId, "startedAt": $0.startedAt.timeIntervalSince1970 * 1000] as [String: Any]
                },
            ])
        }
    }

    @objc func aiAck(_ call: CAPPluginCall) {
        AiRequests.shared.acknowledge(call.getArray("ids", String.self) ?? [])
        call.resolve()
    }

    @objc func aiChatVisible(_ call: CAPPluginCall) {
        let visible = call.getBool("visible") ?? false
        DispatchQueue.main.async {
            AiRequests.shared.setChatVisible(visible)
            call.resolve()
        }
    }

    func emitCommand(requestId: String, command: JSONValue) {
        notifyListeners("command", data: ["requestId": requestId, "command": command.foundation])
    }

    func notifyTabSelected(_ id: String) {
        notifyListeners("tabBarSelect", data: ["id": id])
    }

    /// Стеклянный «шар» Siri сверху экрана, пока помощник думает (active: true/false).
    @objc func siriOrb(_ call: CAPPluginCall) {
        let active = call.getBool("active") ?? false
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                call.reject("Нет экрана приложения")
                return
            }
            let orb = self.orb ?? {
                let created = SiriOrbView()
                self.orb = created
                return created
            }()
            if orb.superview == nil { view.addSubview(orb) }
            // Поверх окон интерфейса, но под системными экранами.
            view.bringSubviewToFront(orb)
            orb.setActive(active, topInset: view.safeAreaInsets.top, in: view)
            call.resolve()
        }
    }

    // MARK: - Сессия и сводка для команд

    /// Адрес сервера и токен (null — вышли из аккаунта). После входа отправляем СМС, ждавшие в очереди.
    @objc func setSession(_ call: CAPPluginCall) {
        BudgetStore.apiBase = call.getString("apiBase")
        let token = call.getString("token")
        BudgetStore.token = token
        if token != nil { BudgetStore.account = call.getString("account") }
        if token == nil {
            BudgetStore.summary = nil
            DispatchQueue.main.async { HomeStore.shared.clear() }
            Task { await LocalSms.shared.clearMirror() }
        }
        call.resolve()
        if token != nil { Task { await SmsQueue.shared.flush() } }
    }

    @objc func setSummary(_ call: CAPPluginCall) {
        guard let date = call.getString("date"), let text = call.getString("text") else {
            call.reject("Нет даты или текста сводки")
            return
        }
        BudgetStore.summary = BudgetStore.Summary(
            date: date,
            text: text,
            expenseCategories: call.getArray("expenseCategories", String.self) ?? [],
            incomeCategories: call.getArray("incomeCategories", String.self) ?? []
        )
        call.resolve()
    }

    // MARK: - Панель вкладок

    /// Интерфейс показал вкладку (selected) — системная панель (RootViewController) переключается следом.
    /// Список вкладок фиксирован в оболочке; кнопка «+» видна всегда.
    @objc func tabBarShow(_ call: CAPPluginCall) {
        let selected = call.getString("selected")
        DispatchQueue.main.async {
            AppShell.shared.root?.applyWebState(selected: selected, overlay: false)
            call.resolve()
        }
    }

    /// Вкладка интерфейса и открыто ли его окно (hidden): пока окно открыто, панель спрятана, а WebView —
    /// поверх нативной Главной.
    @objc func tabBarUpdate(_ call: CAPPluginCall) {
        let selected = call.getString("selected")
        let hidden = call.getBool("hidden")
        DispatchQueue.main.async {
            AppShell.shared.root?.applyWebState(selected: selected, overlay: hidden)
            call.resolve()
        }
    }

    // MARK: - Apple Intelligence

    /// Какие модели Apple доступны: на устройстве и в Private Cloud Compute (iOS 27).
    @objc func aiStatus(_ call: CAPPluginCall) {
        Task {
            var result: [String: Any] = ["device": Self.deviceStatus()]
            if #available(iOS 27.0, *) {
                result["cloud"] = await Self.cloudStatus()
            } else {
                result["cloud"] = ["available": false, "reason": "osTooOld"]
            }
            call.resolve(result)
        }
    }

    private static let russian = Locale(identifier: "ru_RU")

    private static func deviceStatus() -> [String: Any] {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            return ["available": true, "contextSize": model.contextSize, "russian": model.supportsLocale(russian)]
        case .unavailable(let reason):
            let code: String
            switch reason {
            case .deviceNotEligible: code = "deviceNotEligible"
            case .appleIntelligenceNotEnabled: code = "appleIntelligenceNotEnabled"
            case .modelNotReady: code = "modelNotReady"
            @unknown default: code = "unavailable"
            }
            return ["available": false, "reason": code]
        }
    }

    @available(iOS 27.0, *)
    private static func cloudStatus() async -> [String: Any] {
        let model = PrivateCloudComputeLanguageModel()
        switch model.availability {
        case .available:
            let contextSize = (try? await model.contextSize) ?? 0
            let russian = (try? await model.supportsLocale(russian)) ?? false
            return ["available": true, "contextSize": contextSize, "russian": russian]
        case .unavailable(let reason):
            let code: String
            switch reason {
            case .deviceNotEligible: code = "deviceNotEligible"
            case .systemNotReady: code = "modelNotReady"
            @unknown default: code = "unavailable"
            }
            return ["available": false, "reason": code]
        }
    }

    /// Ответ модели Apple. Ошибки не отклоняют вызов, а возвращаются кодом (error): по нему интерфейс решает,
    /// повторить ли с меньшим объёмом данных (context) или подсказать другой режим.
    @objc func aiRespond(_ call: CAPPluginCall) {
        guard let prompt = call.getString("prompt"), !prompt.isEmpty else {
            call.reject("Пустой запрос")
            return
        }
        let instructions = call.getString("instructions") ?? ""
        let useCloud = call.getString("model") == "cloud"
        Task {
            do {
                let options = GenerationOptions(temperature: 0.3)
                let text: String
                if useCloud {
                    guard #available(iOS 27.0, *) else {
                        call.resolve(["error": "unavailable", "message": "Нужна iOS 27."])
                        return
                    }
                    let session = LanguageModelSession(model: PrivateCloudComputeLanguageModel(), instructions: instructions)
                    text = try await session.respond(to: prompt, options: options).content
                } else {
                    let session = LanguageModelSession(model: SystemLanguageModel.default, instructions: instructions)
                    text = try await session.respond(to: prompt, options: options).content
                }
                call.resolve(["text": text])
            } catch {
                call.resolve(["error": Self.errorCode(error), "message": error.localizedDescription])
            }
        }
    }

    private static func errorCode(_ error: Error) -> String {
        if #available(iOS 27.0, *), let error = error as? LanguageModelError {
            switch error {
            case .contextSizeExceeded: return "context"
            case .guardrailViolation, .refusal: return "refused"
            case .unsupportedLanguageOrLocale: return "language"
            case .rateLimited: return "busy"
            case .timeout: return "timeout"
            default: return "failed"
            }
        }
        if let error = error as? LanguageModelSession.GenerationError {
            switch error {
            case .exceededContextWindowSize: return "context"
            case .guardrailViolation, .refusal: return "refused"
            case .unsupportedLanguageOrLocale: return "language"
            case .rateLimited, .concurrentRequests: return "busy"
            default: return "failed"
            }
        }
        if #available(iOS 27.0, *), error is PrivateCloudComputeLanguageModel.Error {
            return "network"
        }
        return "failed"
    }
}
