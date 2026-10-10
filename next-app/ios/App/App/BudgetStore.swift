import Foundation
import Security

/// Данные, которые нужны командам Siri и «Команд», когда интерфейс приложения не запущен:
/// адрес сервера, токен сессии (в Связке ключей), сводка на сегодня и категории.
/// Записывает их интерфейс приложения через плагин BudgetNative.
enum BudgetStore {
    private static let defaults = UserDefaults.standard
    private static let apiBaseKey = "budget.apiBase"
    private static let accountKey = "budget.account"
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

    /// Логин, под которым вошли: СМС из очереди отправляются только в тот аккаунт, в котором пришли.
    static var account: String? {
        get { defaults.string(forKey: accountKey) }
        set { defaults.set(newValue, forKey: accountKey) }
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
        /// Сервер просит подождать (слишком много запросов, данные временно недоступны) — повторить позже.
        case retryLater
        /// Сервер сломался на этом запросе (5xx): повторить позже, но не бесконечно.
        case serverError
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
        case 408, 423, 429: throw Failure.retryLater
        case 500..<600: throw Failure.serverError
        case 0: throw Failure.offline
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
        /// Аккаунт, в который был выполнен вход, когда пришла СМС.
        var account: String?
        /// Сколько раз сервер ответил ошибкой: «битая» СМС не должна вечно держать очередь.
        var failures: Int = 0
    }

    /// После стольких ошибок сервера подряд СМС убирается из очереди.
    private let maxFailures = 5

    enum Stop { case offline, notSignedIn, retryLater, serverError }

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
        items.append(Item(text: text, receivedAt: receivedAt, account: BudgetStore.account))
        let result = await flush()
        switch result.stop {
        case .notSignedIn:
            return "Войдите в приложение «Бюджет» — СМС сохранена и отправится после входа."
        case .offline:
            return "Нет связи с сервером — операция добавится, когда появится интернет."
        case .retryLater, .serverError:
            return "Сервер сейчас не принял СМС — попробуем отправить её позже."
        case nil:
            return result.lastMessage ?? "Готово."
        }
    }

    /// Отправляет очередь по порядку. Останавливается без сети или без входа — тогда СМС ждут следующей попытки.
    @discardableResult
    func flush() async -> FlushResult {
        // Ждём идущую отправку. running обнуляет сама задача, ещё на этом акторе: иначе ожидающий,
        // проснувшись раньше её автора, крутился бы в цикле на завершённой задаче и не отдавал актор.
        while let running {
            _ = await running.value
        }
        let task = Task { () -> FlushResult in
            let result = await self.drain()
            self.running = nil
            return result
        }
        running = task
        return await task.value
    }

    private func drain() async -> FlushResult {
        var lastMessage: String?
        let iso = ISO8601DateFormatter()
        let account = BudgetStore.account
        // СМС другого аккаунта ждут, пока в него снова войдут.
        while let item = items.first(where: { $0.account == nil || $0.account == account }) {
            do {
                let reply = try await BudgetAPI.post(
                    "/api/import/sms",
                    json: ["text": item.text, "receivedAt": iso.string(from: item.receivedAt)]
                )
                lastMessage = reply.message ?? "Готово."
            } catch BudgetAPI.Failure.offline {
                return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: .offline)
            } catch BudgetAPI.Failure.serverError {
                // Сервер может раз за разом падать на одной СМС — считаем попытки, чтобы не застрять навсегда.
                bumpFailures(item.id)
                return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: .serverError)
            } catch BudgetAPI.Failure.retryLater {
                return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: .retryLater)
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
        return FlushResult(lastMessage: lastMessage, remaining: items.count, stop: nil)
    }

    private func bumpFailures(_ id: UUID) {
        var list = items
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        list[index].failures += 1
        if list[index].failures >= maxFailures { list.remove(at: index) }
        items = list
    }
}
