import ActivityKit
import Foundation

/// Ответ помощника в Dynamic Island и на экране блокировки: пока он думает — время и полоса ожидания,
/// когда ответил — начало ответа. Общий файл приложения (запускает и обновляет) и виджета (рисует).
struct AiActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable {
            case thinking, ready, failed
        }

        var phase: Phase
        /// Когда задан вопрос: от него идут таймер и полоса ожидания.
        var startedAt: Date
        /// Сколько примерно ждать (секунд): за это время полоса доходит до конца.
        var expectedSeconds: Int
        /// Пока думает — вопрос, потом — начало ответа или текст ошибки.
        var detail: String
        /// Ответ предлагает изменения — их нужно подтвердить в приложении.
        var hasProposal: Bool = false
    }

    /// Чат, в котором задан вопрос: нажатие открывает его.
    var threadId: String
    /// Кто отвечает: «DeepSeek» или «DeepSeek · с рассуждением».
    var engine: String
}

extension AiActivityAttributes.ContentState {
    var waitInterval: ClosedRange<Date> {
        startedAt...startedAt.addingTimeInterval(TimeInterval(max(expectedSeconds, 3)))
    }
}
