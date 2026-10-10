import Foundation

/// Операции из СМС, разобранные на телефоне. Копию данных для разбора присылает интерфейс; операция сразу
/// ложится в очередь: уходит на сервер, как только есть сеть, и отдаётся интерфейсу при открытии приложения
/// (так она видна и без сети). Номера изменений те же, что дал бы сервер, — дублей не будет.
actor LocalSms {
    static let shared = LocalSms()

    struct Item: Codable, Sendable {
        var id: String
        var ops: [SmsEngine.Op]
        /// Логин аккаунта: операции чужого аккаунта не уходят и не отдаются интерфейсу.
        var account: String
        /// Уже принята сервером (или передана ему по запасному пути).
        var sent: Bool
        /// Текст и время СМС — для запасного пути: если сервер не принял изменения, он разберёт СМС сам.
        var text: String
        var receivedAt: Date
    }

    private struct Mirror: Codable {
        var account: String
        var stateJson: String
    }

    private let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("budget", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var mirrorURL: URL { directory.appendingPathComponent("state-mirror.json") }
    private var inboxURL: URL { directory.appendingPathComponent("sms-inbox.json") }
    private var flushing = false

    private var items: [Item] {
        get { (try? Data(contentsOf: inboxURL)).flatMap { try? JSONDecoder().decode([Item].self, from: $0) } ?? [] }
        set { try? JSONEncoder().encode(Array(newValue.suffix(300))).write(to: inboxURL, options: .atomic) }
    }

    private func readMirror() -> Mirror? {
        (try? Data(contentsOf: mirrorURL)).flatMap { try? JSONDecoder().decode(Mirror.self, from: $0) }
    }

    private func writeMirror(_ mirror: Mirror?) {
        if let mirror, let data = try? JSONEncoder().encode(mirror) {
            try? data.write(to: mirrorURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else {
            try? FileManager.default.removeItem(at: mirrorURL)
        }
    }

    // MARK: - Копия данных

    /// Свежая копия из интерфейса. Операции из СМС, которые интерфейс ещё не принял, накладываются сверху —
    /// иначе следующая СМС того же перевода не увидела бы первую.
    func saveMirror(account: String, stateJson: String) {
        let pending = items.filter { $0.account == account }.map(\.ops)
        let merged = pending.isEmpty ? stateJson : (SmsEngine.shared.apply(stateJson: stateJson, groups: pending) ?? stateJson)
        writeMirror(Mirror(account: account, stateJson: merged))
    }

    /// Вышли из аккаунта — копию его данных не храним.
    func clearMirror() {
        writeMirror(nil)
    }

    // MARK: - СМС

    /// Разбирает СМС на телефоне. nil — разобрать здесь нельзя (нет копии данных, другой аккаунт, разбор
    /// не получился): тогда СМС уходит прежним путём, на разбор сервером.
    func submit(text: String, receivedAt: Date) async -> String? {
        guard BudgetStore.token != nil, let account = BudgetStore.account,
              let mirror = readMirror(), mirror.account == account,
              let plan = SmsEngine.shared.plan(stateJson: mirror.stateJson, text: text, received: receivedAt)
        else { return nil }

        // По копии на телефоне не применилось — пусть решит сервер по своим данным.
        if plan.status == "failed" { return nil }
        // Не операция или уже учтена (и остаток сверять нечем).
        guard !plan.ops.isEmpty else { return plan.message }

        var list = items
        list.append(Item(id: UUID().uuidString, ops: plan.ops, account: account, sent: false, text: text, receivedAt: receivedAt))
        items = list
        if let stateJson = plan.stateJson { writeMirror(Mirror(account: account, stateJson: stateJson)) }

        let delivered = await flush()
        return delivered ? plan.message : "\(plan.message) — отправится, когда появится интернет."
    }

    /// Проверка сборки: разбирает СМС на копии данных и возвращает итог — ничего не сохраняет и не отправляет.
    func dryRun(text: String) async -> String {
        for _ in 0..<20 where readMirror() == nil {
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard let mirror = readMirror() else { return "нет копии данных" }
        guard let plan = SmsEngine.shared.plan(stateJson: mirror.stateJson, text: text, received: Date()) else {
            return "движок не ответил"
        }
        return "\(plan.status) | \(plan.message) | изменений: \(plan.ops.count) | данных: \(mirror.stateJson.count) байт"
    }

    // MARK: - Сервер

    /// Отправляет на сервер операции, которые он ещё не получил. true — неотправленных не осталось.
    @discardableResult
    func flush() async -> Bool {
        guard !flushing else { return false }
        flushing = true
        defer { flushing = false }
        guard let account = BudgetStore.account else { return false }
        for item in items where !item.sent && item.account == account {
            do {
                _ = try await BudgetAPI.post(
                    "/api/state/actions",
                    json: ["baseVersion": 0, "ops": item.ops.map { ["opId": $0.opId, "action": $0.action.foundation] }]
                )
                markSent(item.id)
            } catch BudgetAPI.Failure.rejected {
                // Сервер не смог применить изменения к своим данным (копия на телефоне отстала) —
                // отдаём ему саму СМС: он разберёт её по своим данным.
                markSent(item.id)
                _ = await SmsQueue.shared.submit(text: item.text, receivedAt: item.receivedAt)
            } catch {
                return false
            }
        }
        return true
    }

    private func markSent(_ id: String) {
        var list = items
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        list[index].sent = true
        items = list
    }

    // MARK: - Интерфейс

    /// Операции для интерфейса: он применяет их у себя (видно и без сети) и подтверждает приём.
    func inbox(account: String) -> [Item] {
        items.filter { $0.account == account }
    }

    func acknowledge(_ ids: [String]) {
        let done = Set(ids)
        items = items.filter { !done.contains($0.id) }
    }
}
