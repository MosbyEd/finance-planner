import AppIntents
import Foundation

// Команды приложения: появляются в «Командах» и в Siri и работают без открытия приложения.

/// Операция из СМС банка: в автоматизации «Когда приходит сообщение от 900» достаточно этого действия —
/// без адреса сервера и ключа. Без сети СМС ждёт в очереди и отправится позже.
struct AddSmsOperationIntent: AppIntent {
    static let title: LocalizedStringResource = "Добавить операцию из СМС"
    static let description = IntentDescription(
        "Разбирает СМС банка (номер 900) и добавляет операцию в бюджет. Без интернета СМС подождёт и отправится, когда связь появится."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Текст СМС", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Добавить операцию из СМС \(\.$text)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let message = await SmsQueue.shared.submit(text: text, receivedAt: Date())
        return .result(value: message, dialog: IntentDialog(stringLiteral: message))
    }
}

enum OperationKind: String, AppEnum {
    case expense
    case income

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Тип операции"
    static let caseDisplayRepresentations: [OperationKind: DisplayRepresentation] = [
        .expense: "Расход",
        .income: "Доход",
    ]
}

/// Категории пользователя — из сводки, которую сохраняет приложение.
struct CategoryOptions: DynamicOptionsProvider {
    func results() async throws -> [String] {
        guard let summary = BudgetStore.summary else { return [] }
        var seen = Set<String>()
        return (summary.expenseCategories + summary.incomeCategories).filter { seen.insert($0).inserted }
    }
}

struct AddOperationIntent: AppIntent {
    static let title: LocalizedStringResource = "Добавить операцию"
    static let description = IntentDescription(
        "Добавляет расход или доход в бюджет. Категорию можно не указывать — её подберёт приложение по названию."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Тип", default: .expense)
    var kind: OperationKind

    @Parameter(title: "Сумма, ₽", inclusiveRange: (0.01, 1_000_000_000))
    var amount: Double

    @Parameter(title: "Название", description: "Магазин или на что потрачено")
    var name: String?

    @Parameter(title: "Категория", optionsProvider: CategoryOptions())
    var category: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Добавить \(\.$kind) \(\.$amount)") {
            \.$name
            \.$category
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let kopecks = Int((amount * 100).rounded())
        var body: [String: Any] = ["type": kind.rawValue, "amount": kopecks]
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { body["title"] = name }
        if let category, !category.trimmingCharacters(in: .whitespaces).isEmpty { body["category"] = category }
        let message: String
        do {
            message = try await BudgetAPI.post("/api/shortcuts/add", json: body).message ?? "Добавлено."
        } catch BudgetAPI.Failure.notSignedIn {
            message = "Сначала войдите в приложение «Бюджет»."
        } catch BudgetAPI.Failure.offline {
            message = "Нет связи с сервером — откройте приложение и добавьте операцию там: без сети она сохранится на телефоне."
        } catch BudgetAPI.Failure.rejected(let text) {
            message = text
        }
        return .result(value: message, dialog: IntentDialog(stringLiteral: message))
    }
}

struct TodayBudgetIntent: AppIntent {
    static let title: LocalizedStringResource = "Сколько можно потратить сегодня"
    static let description = IntentDescription("Лимит на сегодня — сколько можно потратить, чтобы хватило на обязательные платежи.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let message: String
        do {
            message = try await BudgetAPI.get("/api/shortcuts/today").message ?? "Нет данных."
        } catch BudgetAPI.Failure.notSignedIn {
            message = "Сначала войдите в приложение «Бюджет»."
        } catch {
            // Без сети — последняя сводка с телефона, если она сегодняшняя.
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.dateFormat = "yyyy-MM-dd"
            if let summary = BudgetStore.summary, summary.date == formatter.string(from: Date()) {
                message = summary.text
            } else {
                message = "Нет связи с сервером. Откройте приложение, чтобы обновить данные."
            }
        }
        return .result(value: message, dialog: IntentDialog(stringLiteral: message))
    }
}

struct BudgetShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TodayBudgetIntent(),
            phrases: [
                "Сколько можно потратить в \(.applicationName)",
                "Лимит на сегодня в \(.applicationName)",
                "How much can I spend in \(.applicationName)",
            ],
            shortTitle: "Лимит на сегодня",
            systemImageName: "rublesign.circle"
        )
        AppShortcut(
            intent: AddOperationIntent(),
            phrases: [
                "Добавить расход в \(.applicationName)",
                "Записать трату в \(.applicationName)",
                "Add expense in \(.applicationName)",
            ],
            shortTitle: "Добавить операцию",
            systemImageName: "plus.circle"
        )
    }
}
