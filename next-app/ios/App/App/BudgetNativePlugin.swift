import Capacitor
import Foundation
import FoundationModels

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
        CAPPluginMethod(name: "siriOrb", returnType: CAPPluginReturnPromise),
    ]

    private var tabBar: GlassTabBar?
    private var orb: SiriOrbView?

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
        if token == nil { BudgetStore.summary = nil }
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

    // MARK: - Нижняя панель Liquid Glass

    /// Показывает нативную панель вкладок: items — [{id, title, symbol, selectedSymbol}], selected, action (кнопка «+»).
    /// Нажатия приходят событиями tabBarSelect {id} и tabBarAction.
    @objc func tabBarShow(_ call: CAPPluginCall) {
        let items = (call.getArray("items", JSObject.self) ?? []).compactMap { raw -> GlassTabBar.Item? in
            guard let id = raw["id"] as? String, let title = raw["title"] as? String, let symbol = raw["symbol"] as? String else {
                return nil
            }
            return GlassTabBar.Item(id: id, title: title, symbol: symbol, selectedSymbol: raw["selectedSymbol"] as? String ?? symbol)
        }
        let selected = call.getString("selected")
        let action = call.getBool("action") ?? false
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                call.reject("Нет экрана приложения")
                return
            }
            let bar = self.tabBar ?? self.makeTabBar(in: view)
            bar.setItems(items)
            bar.select(selected, animated: false)
            bar.setActionVisible(action, animated: false)
            bar.setHiddenByApp(false, animated: false)
            call.resolve()
        }
    }

    /// Меняет выбранную вкладку, кнопку «+» и видимость панели (hidden — пока открыто окно интерфейса).
    @objc func tabBarUpdate(_ call: CAPPluginCall) {
        let selected = call.getString("selected")
        let action = call.getBool("action")
        let hidden = call.getBool("hidden")
        DispatchQueue.main.async {
            guard let bar = self.tabBar else {
                call.reject("Панель не показана")
                return
            }
            if let selected { bar.select(selected, animated: true) }
            if let action { bar.setActionVisible(action, animated: true) }
            if let hidden { bar.setHiddenByApp(hidden, animated: true) }
            call.resolve()
        }
    }

    private func makeTabBar(in view: UIView) -> GlassTabBar {
        let bar = GlassTabBar()
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        // Как у системной панели: над индикатором «Домой», не ниже 12 pt от края на экранах без него.
        let toSafeArea = bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: 8)
        toSafeArea.priority = .defaultHigh
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bar.heightAnchor.constraint(equalToConstant: 64),
            bar.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -12),
            toSafeArea,
        ])
        bar.onSelect = { [weak self] id in self?.notifyListeners("tabBarSelect", data: ["id": id]) }
        bar.onAction = { [weak self] in self?.notifyListeners("tabBarAction", data: [:]) }
        tabBar = bar
        return bar
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
