import ActivityKit
import SwiftUI
import WidgetKit

/// Виджет «Сколько можно потратить сегодня»: рабочий стол и экран блокировки.
/// Цифру считает приложение (WidgetSnapshot в общей папке App Group), виджет только показывает её.
@main
struct BudgetWidgets: WidgetBundle {
    var body: some Widget {
        TodayLimitWidget()
        AiLiveActivity()
    }
}

struct TodayLimitWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TodayLimit", provider: Provider()) { entry in
            TodayLimitView(entry: entry)
        }
        .configurationDisplayName("Лимит на сегодня")
        .description("Сколько можно потратить сегодня, чтобы хватило на обязательные платежи и сбережения.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline, .accessoryCircular])
    }
}

struct Entry: TimelineEntry {
    let date: Date
    /// nil — ещё нет данных (не входили в приложение или нет остатка).
    let snapshot: WidgetSnapshot?
    /// Цифра посчитана не на сегодня: после полуночи лимит другой, пока приложение его не пересчитает.
    let stale: Bool
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, snapshot: .sample, stale: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry(at: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date.now
        let midnight = Calendar.current.startOfDay(for: now).addingTimeInterval(24 * 60 * 60 + 60)
        // Сейчас и сразу после полуночи (там цифра станет «вчерашней»). Новые данные приложение присылает само.
        completion(Timeline(entries: [entry(at: now), entry(at: midnight)], policy: .after(midnight)))
    }

    private func entry(at date: Date) -> Entry {
        let snapshot = WidgetSnapshot.load()
        return Entry(date: date, snapshot: snapshot, stale: snapshot.map { $0.date != WidgetSnapshot.today(date) } ?? false)
    }
}

extension WidgetSnapshot {
    static let sample = WidgetSnapshot(
        date: WidgetSnapshot.today(),
        label: "Сегодня можно потратить",
        amount: "2 047 ₽",
        status: "Всё по плану",
        statusTone: "positive",
        detail: "Лимит на день 2 300 ₽ · потрачено 253 ₽",
        over: false
    )
}

// MARK: - Вид

private enum Palette {
    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    // Фон виджета. В тёмной теме — глубокий индиго (как у карточки лимита в приложении), текст в обеих — белый.
    static let accent = dynamic(0x3F51D9, 0x2E3BA6)
    static let accent2 = dynamic(0x5A3FD6, 0x45309F)
    static let accentText = Color.white

    static func statusSymbol(_ tone: String) -> String {
        switch tone {
        case "positive": "checkmark.circle.fill"
        case "warning": "exclamationmark.circle.fill"
        case "negative": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }

    /// Светлые тона значка статуса, читаемые на индиго.
    static func statusIcon(_ tone: String) -> Color {
        switch tone {
        case "positive": Color(red: 0.49, green: 0.94, blue: 0.72)
        case "warning": Color(red: 1, green: 0.82, blue: 0.48)
        case "negative": Color(red: 1, green: 0.6, blue: 0.66)
        default: .white.opacity(0.8)
        }
    }
}

struct TodayLimitView: View {
    let entry: Entry
    @Environment(\.widgetFamily) private var family
    /// На рабочем столе в стеклянном или тонированном режиме система перекрашивает виджет в один цвет:
    /// плашка статуса с подложкой там становится белой полосой без текста.
    @Environment(\.widgetRenderingMode) private var renderingMode

    private var openURL: URL { URL(string: "budget://home")! }

    var body: some View {
        content
            .widgetURL(openURL)
            .containerBackground(for: .widget) {
                if family == .systemSmall || family == .systemMedium {
                    LinearGradient(colors: [Palette.accent, Palette.accent2], startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    Color.clear
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            if let s = usable {
                Text("Можно сегодня: \(s.amount)")
            } else {
                Text("Бюджет: откройте приложение")
            }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(usable.map { compact($0.amount) } ?? "—")
                        .font(.system(size: 15, weight: .bold))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                    Text("₽").font(.caption2).foregroundStyle(.secondary)
                }
                .padding(4)
            }
            .accessibilityLabel(usable.map { "Можно потратить сегодня \($0.amount)" } ?? "Откройте приложение Бюджет")
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text(usable?.label ?? "Бюджет").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(usable?.amount ?? "Откройте приложение")
                    .font(.system(size: 22, weight: .bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .widgetAccentable()
                if let s = usable {
                    Text(s.status).font(.caption2).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemMedium:
            HStack(alignment: .top, spacing: 12) {
                summary(detail: true)
                Spacer(minLength: 0)
                Link(destination: URL(string: "budget://add")!) {
                    Label("Расход", systemImage: "plus")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Palette.accentText.opacity(0.18), in: .capsule)
                }
            }
            .foregroundStyle(Palette.accentText)
        default:
            summary(detail: false)
                .foregroundStyle(Palette.accentText)
        }
    }

    /// Лимит, если он посчитан на сегодня.
    private var usable: WidgetSnapshot? {
        entry.stale ? nil : entry.snapshot
    }

    @ViewBuilder
    private func summary(detail: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let s = usable {
                Text(s.over ? "Сверх лимита сегодня" : "Можно сегодня")
                    .font(.footnote)
                    .opacity(0.9)
                Text(s.amount)
                    .font(.system(size: 30, weight: .bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .contentTransition(.numericText())
                Spacer(minLength: 0)
                if renderingMode == .fullColor {
                    // Как на карточке лимита в приложении: светлая капсула на индиго, смысл — значком.
                    HStack(spacing: 4) {
                        Image(systemName: Palette.statusSymbol(s.statusTone))
                            .foregroundStyle(Palette.statusIcon(s.statusTone))
                        Text(s.status).lineLimit(1)
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.white.opacity(0.16), in: .capsule)
                } else {
                    Text(s.status)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .widgetAccentable()
                }
                if detail {
                    Text(s.detail).font(.caption).opacity(0.9).lineLimit(2)
                }
            } else {
                Text("Бюджет").font(.headline)
                Spacer(minLength: 0)
                Text(entry.snapshot == nil ? "Откройте приложение — здесь появится лимит на сегодня" : "Откройте приложение, чтобы пересчитать лимит на сегодня")
                    .font(.footnote)
                    .opacity(0.9)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// «12 345 ₽» → «12 345» для круглого виджета.
    private func compact(_ amount: String) -> String {
        amount.replacingOccurrences(of: "₽", with: "").trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\u{00a0}\u{202f}")))
    }
}

// MARK: - Помощник в Dynamic Island

/// Ответ помощника: пока думает — таймер и полоса ожидания (система двигает её сама, без обновлений),
/// когда ответил — начало ответа. Нажатие открывает чат.
struct AiLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AiActivityAttributes.self) { context in
            AiLockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.35))
                .widgetURL(Self.link(context.attributes))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Помощник", systemImage: "sparkles")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AiPalette.glow)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AiStatusText(state: state)
                        .font(.subheadline.weight(.semibold))
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.phase == .thinking ? "«\(state.detail)»" : state.detail)
                            .font(.subheadline)
                            .lineLimit(2)
                            .foregroundStyle(.white.opacity(state.phase == .thinking ? 0.75 : 1))
                        AiProgress(state: state, engine: context.attributes.engine)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                AiIcon(phase: state.phase)
            } compactTrailing: {
                AiStatusText(state: state)
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: 52)
            } minimal: {
                AiIcon(phase: state.phase)
            }
            .widgetURL(Self.link(context.attributes))
            .keylineTint(AiPalette.glow)
        }
    }

    static func link(_ attributes: AiActivityAttributes) -> URL? {
        var components = URLComponents()
        components.scheme = "budget"
        components.host = "ai"
        components.queryItems = [URLQueryItem(name: "thread", value: attributes.threadId)]
        return components.url
    }
}

enum AiPalette {
    static let glow = Color(red: 0.62, green: 0.6, blue: 1)
    static let ready = Color(red: 0.49, green: 0.94, blue: 0.72)
    static let failed = Color(red: 1, green: 0.72, blue: 0.48)
}

struct AiIcon: View {
    let phase: AiActivityAttributes.ContentState.Phase

    var body: some View {
        switch phase {
        case .thinking:
            Image(systemName: "sparkles")
                .foregroundStyle(AiPalette.glow)
                .symbolEffect(.pulse, options: .repeating)
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(AiPalette.ready)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(AiPalette.failed)
        }
    }
}

/// Справа: сколько уже думает (таймер идёт сам) или «Готово».
struct AiStatusText: View {
    let state: AiActivityAttributes.ContentState

    var body: some View {
        switch state.phase {
        case .thinking:
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(AiPalette.glow)
        case .ready:
            Text("Готово").foregroundStyle(AiPalette.ready)
        case .failed:
            Text("Ошибка").foregroundStyle(AiPalette.failed)
        }
    }
}

struct AiProgress: View {
    let state: AiActivityAttributes.ContentState
    let engine: String

    var body: some View {
        switch state.phase {
        case .thinking:
            ProgressView(timerInterval: state.waitInterval, countsDown: false) {
                Text("\(engine) думает…").font(.caption).foregroundStyle(.white.opacity(0.7))
            } currentValueLabel: {
                EmptyView()
            }
            .tint(AiPalette.glow)
        case .ready:
            Text(state.hasProposal ? "Предлагает изменения — откройте, чтобы подтвердить" : "Нажмите, чтобы открыть ответ")
                .font(.caption)
                .foregroundStyle(AiPalette.ready)
        case .failed:
            Text("Нажмите, чтобы повторить").font(.caption).foregroundStyle(AiPalette.failed)
        }
    }
}

struct AiLockScreenView: View {
    let context: ActivityViewContext<AiActivityAttributes>

    var body: some View {
        let state = context.state
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                AiIcon(phase: state.phase)
                Text(state.phase == .thinking ? "Помощник думает" : state.phase == .ready ? "Ответ готов" : "Помощник не ответил")
                    .font(.headline)
                Spacer()
                AiStatusText(state: state).font(.subheadline.weight(.semibold))
            }
            Text(state.phase == .thinking ? "«\(state.detail)»" : state.detail)
                .font(.subheadline)
                .lineLimit(3)
                .foregroundStyle(.white.opacity(state.phase == .thinking ? 0.75 : 1))
            AiProgress(state: state, engine: context.attributes.engine)
        }
        .foregroundStyle(.white)
        .padding(16)
    }
}
