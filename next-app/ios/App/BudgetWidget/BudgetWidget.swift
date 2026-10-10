import SwiftUI
import WidgetKit

/// Виджет «Сколько можно потратить сегодня»: рабочий стол и экран блокировки.
/// Цифру считает приложение (WidgetSnapshot в общей папке App Group), виджет только показывает её.
@main
struct BudgetWidgets: WidgetBundle {
    var body: some Widget {
        TodayLimitWidget()
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
