import Foundation

/// Произвольный JSON: команды интерфейса, которые нативный экран возвращает как есть.
enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// Значение для моста Capacitor (NSString, NSNumber, NSNull, словари и массивы).
    var foundation: Any {
        switch self {
        case .string(let value): value
        case .number(let value): value.rounded() == value && abs(value) < 1e15 ? Int(value) as Any : value
        case .bool(let value): value
        case .object(let value): value.mapValues(\.foundation)
        case .array(let value): value.map(\.foundation)
        case .null: NSNull()
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    static func command(_ type: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["type": .string(type)]) { current, _ in current })
    }
}

/// Смысловой тон из дизайн-кода. Незнакомое значение — приглушённый.
enum Tone: String, Codable, Hashable, Sendable {
    case accent, positive, warning, negative, muted, `default`

    init(from decoder: Decoder) throws {
        self = Tone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .muted
    }
}

/// Модель нативной Главной. Её строит интерфейс (src/components/app/native/homeModel.ts) — тем же кодом,
/// что считает веб-экран; здесь всё уже посчитано и отформатировано.
struct HomeModel: Codable, Equatable, Sendable {
    struct Sync: Codable, Equatable, Sendable {
        var text: String
        var tone: Tone
        var symbol: String
    }

    struct Status: Codable, Equatable, Sendable {
        var text: String
        var tone: Tone
    }

    /// Лимит на сегодня (kind = limit) или просьба указать остаток (kind = balance).
    struct Today: Codable, Equatable, Sendable {
        var kind: String
        var label: String?
        var amount: String?
        var status: Status?
        var detail: String?
        var gap: String?
        var over: Bool?
        var text: String?
    }

    struct Action: Codable, Equatable, Sendable {
        var label: String
        var primary: Bool
        var command: JSONValue
    }

    struct Attention: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var symbol: String
        var tone: Tone
        var title: String
        var text: String?
        var command: JSONValue?
        var actions: [Action]
        /// Крестик в углу — скрыть, ничего не меняя.
        var dismiss: JSONValue?
    }

    struct Step: Codable, Equatable, Sendable {
        var title: String
        var done: Bool
        var doneText: String
        var actions: [Action]
    }

    struct Onboarding: Codable, Equatable, Sendable {
        var done: Int
        var intro: String?
        var steps: [Step]
        var importHint: Bool
    }

    struct Quick: Codable, Equatable, Sendable, Identifiable {
        var key: String
        var title: String
        var amount: String
        var id: String { key }
    }

    struct Tiles: Codable, Equatable, Sendable {
        var balanceLabel: String?
        var balance: String
        var balanceNegative: Bool
        var balanceHint: String
        var savings: String
    }

    struct Month: Codable, Equatable, Sendable {
        var title: String
        var label: String
        var amount: String
        var negative: Bool
        var of: String
        var progress: Double
        var tone: Tone
        var daysLeft: String?
        /// «После аванса: ≈ 1 850 ₽ в день на 15 дней» — у периода от зарплаты до зарплаты.
        var next: String?
        /// Почему остаток — по деньгам на счетах («Зарплаты 10 октября в приложении нет…»).
        var note: String?
        /// «Подробнее»: у периода от зарплаты до зарплаты — «Как посчитано», у месяца — Аналитика.
        var more: JSONValue?
    }

    struct Upcoming: Codable, Equatable, Sendable, Identifiable {
        var key: String
        var title: String
        var when: String
        var after: String
        var afterNegative: Bool
        var amount: String
        var positive: Bool
        var command: JSONValue?
        var id: String { key }
    }

    struct Recent: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var title: String
        var subtitle: String
        var amount: String
        var amountTone: Tone
        var symbol: String
        var tint: Tone
        var autoSaving: String?
        var command: JSONValue
    }

    /** Счёт на Главной: остаток, у кредитки — долг и беспроцентный период. */
    struct Account: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var name: String
        var symbol: String
        var amount: String
        var negative: Bool
        var detail: String
        var overdue: Bool
        var command: JSONValue
    }

    struct CardChoice: Codable, Equatable, Sendable, Hashable, Identifiable {
        var digits: String
        var label: String
        var id: String { digits }
    }

    struct AccountChoice: Codable, Equatable, Sendable, Hashable, Identifiable {
        var id: String
        var name: String
        var symbol: String
        var cards: [CardChoice]?
        var lastCard: String?
        /// Остаток в копейках (у кредитки — минус долг); nil — суммы спрятаны глазком.
        var balance: Int?
        var limit: Int?
        var credit: Bool?
        var savings: Bool?

        /// Сколько на счёте после изменения delta: у кредитки — доступный лимит (без лимита — долг), иначе остаток.
        /// nil — суммы спрятаны. short — без подписи «доступно» (для чипа).
        func funds(delta: Int = 0, short: Bool = false) -> (text: String, negative: Bool)? {
            guard let balance else { return nil }
            let value = balance + delta
            if credit == true {
                if let limit {
                    let available = limit + value
                    let text = Money.whole(available)
                    return (short ? text : "доступно \(text)", available < 0)
                }
                let debt = max(0, -value)
                return (debt > 0 ? "долг \(Money.whole(debt))" : "долга нет", false)
            }
            return (Money.whole(value), value < 0)
        }
    }

    struct Pick: Codable, Equatable, Sendable, Hashable {
        var title: String
        var category: String
        /// Копейки.
        var amount: Int
        var amountText: String
    }

    /// Правила автоотчислений — как в src/domain/savings.ts: окно показывает, сколько уйдёт в сбережения.
    struct SavingRules: Codable, Equatable, Sendable {
        struct Purchase: Codable, Equatable, Sendable {
            var enabled: Bool
            var percent: Int
            var cap: Int
            var roundTo: Int
            var excluded: [String]
            /// Переводить, когда накопится (0 — сразу).
            var minTransfer: Int?
            /// С покупок по этим счетам и картам не откладывать.
            var excludedAccounts: [String]?
            var excludedCards: [String]?
        }
        struct Salary: Codable, Equatable, Sendable {
            var enabled: Bool
            var percent: Int
            var categories: [String]
            var minTransfer: Int?
        }
        var purchase: Purchase
        var salary: Salary

        /// Процент, округлённый до целых рублей (percentOf).
        private static func percent(_ kopecks: Int, _ percent: Int) -> Int {
            Int((Double(kopecks * percent) / 100 / 100).rounded()) * 100
        }

        /// С какой суммы переводятся накопленные отчисления этого вида (0 — сразу).
        func threshold(expense: Bool) -> Int { (expense ? purchase.minTransfer : salary.minTransfer) ?? 0 }

        /// Сколько уйдёт в сбережения с операции (0 — отчисления нет). accountId и card — откуда покупка.
        func amount(expense: Bool, amount: Int, category: String, accountId: String = "main", card: String? = nil) -> Int {
            guard amount > 0 else { return 0 }
            if expense {
                guard purchase.enabled, !purchase.excluded.contains(category) else { return 0 }
                if (purchase.excludedAccounts ?? []).contains(accountId) { return 0 }
                if let card, (purchase.excludedCards ?? []).contains(card) { return 0 }
                let percentPart = min(Self.percent(amount, purchase.percent), purchase.cap)
                let roundPart = purchase.roundTo > 0 ? (amount + purchase.roundTo - 1) / purchase.roundTo * purchase.roundTo - amount : 0
                return percentPart + roundPart
            }
            guard salary.enabled, salary.categories.contains(category) else { return 0 }
            return Self.percent(amount, salary.percent)
        }
    }

    struct Add: Codable, Equatable, Sendable {
        var expense: [String]
        var income: [String]
        /// Частые категории — чипами сразу, остальные — в списке «Все категории».
        var expenseTop: [String]?
        var incomeTop: [String]?
        var lastExpense: String?
        var lastIncome: String?
        var picks: [Pick]
        /// Счета для выбора; пусто — выбора нет, всё на основном.
        var accounts: [AccountChoice]?
        /// Счета для перевода — все свои, с накопительными.
        var transferAccounts: [AccountChoice]?
        /// Категории, расход по которым по умолчанию обязательный.
        var mandatoryCategories: [String]?
        var saving: SavingRules?
        var lastExpenseAccount: String?
        var lastIncomeAccount: String?
    }

    var date: String
    var sync: Sync
    var assistant: Bool
    var hasData: Bool
    var today: Today?
    var attention: [Attention]
    var onboarding: Onboarding?
    var quick: [Quick]
    var tiles: Tiles?
    var accounts: [Account]?
    var accountsTotal: Int?
    /// Суммы счетов спрятаны глазком: показать — по Face ID.
    var balancesHidden: Bool?
    var month: Month?
    var upcoming: [Upcoming]
    var recent: [Recent]
    var add: Add
}

/// Ответ интерфейса на команду.
struct CommandResult: Sendable {
    var ok: Bool
    var txId: String?
    var message: String?
    var error: String?

    init(ok: Bool, txId: String? = nil, message: String? = nil, error: String? = nil) {
        self.ok = ok
        self.txId = txId
        self.message = message
        self.error = error
    }

    init(_ json: JSONValue) {
        ok = json["ok"]?.bool ?? false
        txId = json["txId"]?.string
        message = json["message"]?.string
        error = json["error"]?.string ?? (ok ? nil : "Не получилось.")
    }
}

/// Последняя модель Главной: приходит из интерфейса при каждом изменении данных и хранится до следующего
/// запуска — Главная открывается сразу, ещё до загрузки интерфейса.
@MainActor
@Observable
final class HomeStore {
    static let shared = HomeStore()

    private(set) var model: HomeModel?
    /// Модель пришла в этом запуске: интерфейс загружен и принимает команды.
    private(set) var live = false

    private let cacheKey = "budget.homeModel"

    private init() {
        if let data = UserDefaults.standard.data(forKey: cacheKey) {
            model = try? JSONDecoder().decode(HomeModel.self, from: data)
        }
    }

    func update(_ next: HomeModel) {
        // Первая модель в запуске уходит в виджет, даже если совпала с сохранённой: виджет мог
        // остаться без данных (переустановка, первый запуск с виджетом).
        let first = !live
        live = true
        guard first || next != model else { return }
        model = next
        if let data = try? JSONEncoder().encode(next) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
        WidgetSnapshot.publish(from: next)
    }

    /// Вышли из аккаунта: чужие цифры не должны оставаться на экране и в виджете.
    func clear() {
        model = nil
        UserDefaults.standard.removeObject(forKey: cacheKey)
        WidgetSnapshot.clear()
    }
}

extension WidgetSnapshot {
    /// Лимит на сегодня из модели Главной; без лимита (нет данных или остатка) виджет просит открыть приложение.
    static func publish(from model: HomeModel) {
        guard let today = model.today, today.kind == "limit", let amount = today.amount, let status = today.status else {
            save(nil)
            return
        }
        save(WidgetSnapshot(
            date: model.date,
            label: today.label ?? "Сегодня можно потратить",
            amount: amount,
            status: status.text,
            statusTone: status.tone.rawValue,
            detail: today.detail ?? "",
            over: today.over ?? false
        ))
    }
}

/// Суммы для показа: целые рубли с пробелами между разрядами — «155 968 ₽», «−1 200 ₽».
enum Money {
    private static let formatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "ru_RU")
        f.maximumFractionDigits = 0
        f.roundingMode = .halfUp
        return f
    }()

    static func whole(_ kopecks: Int) -> String {
        let rubles = (Double(abs(kopecks)) / 100).rounded()
        let text = formatter.string(from: NSNumber(value: rubles)) ?? "\(Int(rubles))"
        return "\(kopecks < 0 ? "−" : "")\(text) ₽"
    }
}
