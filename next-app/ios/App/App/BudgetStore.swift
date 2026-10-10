import Foundation
import Security

/// Данные, которые нужны командам Siri и «Команд», когда интерфейс приложения не запущен:
/// адрес сервера, токен сессии (в Связке ключей), сводка на сегодня и категории.
/// Записывает их интерфейс приложения через плагин BudgetNative.
enum BudgetStore {
    private static let defaults = UserDefaults.standard
    private static let apiBaseKey = "budget.apiBase"
    private static let summaryKey = "budget.summary"
    private static let keychainService = "ru.ekinosian.budget"
    private static let keychainAccount = "session"

    /// Сводка, которую интерфейс пересчитывает при каждом изменении данных.
    struct Summary: Codable {
        /// День, на который посчитана сводка (YYYY-MM-DD).
        var date: String
        /// Готовая фраза: «Сегодня можно потратить …».
        var text: String
        var expenseCategories: [String]
        var incomeCategories: [String]
    }

    static var apiBase: String? {
        get { defaults.string(forKey: apiBaseKey) }
        set { defaults.set(newValue, forKey: apiBaseKey) }
    }

    static var summary: Summary? {
        get { defaults.data(forKey: summaryKey).flatMap { try? JSONDecoder().decode(Summary.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: summaryKey) }
    }

    private static var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    /// Токен сессии. Доступен после первой разблокировки — автоматизация по СМС срабатывает и на заблокированном телефоне.
    static var token: String? {
        get {
            var query = keychainQuery
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            SecItemDelete(keychainQuery as CFDictionary)
            guard let newValue, let data = newValue.data(using: .utf8) else { return }
            var item = keychainQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}

/// Запросы к серверу бюджета от имени вошедшего пользователя.
enum BudgetAPI {
    enum Failure: Error {
        /// Не вошли в приложение (или сессия истекла).
        case notSignedIn
        /// Нет сети или сервер недоступен — стоит повторить позже.
        case offline
        /// Сервер ответил ошибкой; текст можно показать как есть.
        case rejected(String)
    }

    struct Reply: Decodable {
        var status: String?
        var message: String?
        var error: String?
    }

    static func get(_ path: String) async throws -> Reply {
        try await send(path, method: "GET", body: nil)
    }

    static func post(_ path: String, json: [String: Any]) async throws -> Reply {
        try await send(path, method: "POST", body: try JSONSerialization.data(withJSONObject: json))
    }

    private static func send(_ path: String, method: String, body: Data?) async throws -> Reply {
        guard let token = BudgetStore.token, let base = BudgetStore.apiBase, let url = URL(string: base + path) else {
            throw Failure.notSignedIn
        }
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("native", forHTTPHeaderField: "X-Client")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reply = (try? JSONDecoder().decode(Reply.self, from: data)) ?? Reply()
        switch status {
        case 200..<300: return reply
        case 401: throw Failure.notSignedIn
        case 500..<600, 0: throw Failure.offline
        default: throw Failure.rejected(reply.message ?? reply.error ?? "Сервер ответил ошибкой \(status).")
        }
    }
}

/// СМС банка, которые ждут отправки на сервер: без сети автоматизация не теряет операцию, а откладывает её.
actor SmsQueue {
    static let shared = SmsQueue()

    private struct Item: Codable {
        var id = UUID()
        var text: String
        var receivedAt: Date
    }

    enum Stop { case offline, notSignedIn }

    struct FlushResult {
        /// Ответ сервера на последнюю отправленную СМС.
        var lastMessage: String?
        var remaining: Int
        var stop: Stop?
    }

    private let key = "budget.smsQueue"
    private let limit = 200
    /// Идущая отправка: вторая СМС, пришедшая во время отправки, ждёт её, а не шлёт ту же очередь параллельно.
    private var running: Task<FlushResult, Never>?

    private var items: [Item] {
        get {
            UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([Item].self, from: $0) } ?? []
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(Array(newValue.suffix(limit))), forKey: key) }
    }

    /// Отправляет СМС (и всё, что ждало в очереди до неё). Возвращает фразу для уведомления.
    func submit(text: String, receivedAt: Date) async -> String {
        items.append(Item(text: text, receivedAt: receivedAt))
        let result = await flush()
        switch result.stop {
        case .notSignedIn:
            return "Войдите в приложение «Бюджет» — СМС сохранена и отправится после входа."
        case .offline:
            return "Нет связи с сервером — операция добавится, когда появится интернет."
        case nil:
            return result.lastMessage ?? "Готово."
        }
    }

    /// Отправляет очередь по порядку. Останавливается без сети или без входа — тогда СМС ждут следующей попытки.
    @discardableResult
    func flush() async -> FlushResult {
        while let running {
            _ = await running.value
        }
        let task = Task { await self.drain() }
        running = task
        let result = await task.value
        running = nil
        return result
    }

    private func drain() async -> FlushResult {
        var lastMessage: String?
        let iso = ISO8601DateFormatter()
        while let item = items.first {
            do {
                let reply = try await BudgetAPI.post(
                    "/api/import/sms",
                    json: ["text": item.text, "receivedAt": iso.string(from: item.receivedAt)]
                )
                lastMessage = reply.message ?? "Готово."
            } catch BudgetAPI.Failure.offline {
                return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: .offline)
            } catch BudgetAPI.Failure.notSignedIn {
                return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: .notSignedIn)
            } catch BudgetAPI.Failure.rejected(let message) {
                // Сервер отказал (непонятный текст и т. п.) — повторять бессмысленно.
                lastMessage = message
            } catch {
                lastMessage = "Не удалось отправить СМС."
            }
            items.removeAll { $0.id == item.id }
        }
        return FlushResult(lastMessage: lastMessage, remaining: 0, stop: nil)
    }
}
