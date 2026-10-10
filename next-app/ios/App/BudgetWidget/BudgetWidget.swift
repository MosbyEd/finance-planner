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

    static let accent = dynamic(0x3F51D9, 0x8796FF)
    static let accent2 = dynamic(0x5A3FD6, 0xA08CFF)
    static let accentText = dynamic(0xFFFFFF, 0x0F1120)

    static func statusColor(_ tone: String) -> Color {
        switch tone {
        case "positive": dynamic(0x0B7651, 0x3DC58E)
        case "warning": dynamic(0x965A00, 0xF0A83A)
        case "negative": dynamic(0xC02F43, 0xFF7083)
        default: dynamic(0x5F5C56, 0xA3A09A)
        }
    }

    static func statusSoft(_ tone: String) -> Color {
        switch tone {
        case "positive": dynamic(0xE3F4EC, 0x163326)
        case "warning": dynamic(0xFDF1DC, 0x3A2A12)
        case "negative": dynamic(0xFBE7EA, 0x3A1C22)
        default: dynamic(0xF0EFEB, 0x242421)
        }
    }
}

struct TodayLimitView: View {
    let entry: Entry
    @Environment(\.widgetFamily) private var family

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
                Text(s.status)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .foregroundStyle(Palette.statusColor(s.statusTone))
                    .background(Palette.statusSoft(s.statusTone), in: .capsule)
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
