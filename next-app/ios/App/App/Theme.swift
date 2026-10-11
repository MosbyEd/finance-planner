import SwiftUI
import UIKit

/// Цвета дизайн-кода (docs/design-code.md, src/app/globals.css): светлая и тёмная темы.
enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? rgb(dark, darkAlpha) : rgb(light, lightAlpha)
        }
    }

    private static func rgb(_ hex: UInt32, _ alpha: CGFloat) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    static let accentUI = dynamic(0x3F51D9, 0x8796FF)
    /// Заливка основных кнопок («+», «Добавить», «Отложить»): в тёмной теме — глубокий индиго под белым текстом,
    /// а не светлый accent (светло-сиреневая заливка на тёмном фоне выглядит блёкло).
    static let actionUI = dynamic(0x3F51D9, 0x4655DB)
    static let action = Color(actionUI)
    static let bgUI = dynamic(0xF4F4F1, 0x111110)

    static let accent = Color(accentUI)
    static let accent2 = Color(dynamic(0x5A3FD6, 0xA08CFF))
    static let accentSoft = Color(dynamic(0xE9EBFC, 0x262B4D))
    static let bg = Color(bgUI)
    static let surface2 = Color(dynamic(0xF0EFEB, 0x242421))
    static let surface3 = Color(dynamic(0xE7E5E0, 0x2F2F2B))
    static let text = Color(dynamic(0x1C1B19, 0xF1F0EC))
    static let muted = Color(dynamic(0x5F5C56, 0xA3A09A))
    static let fill = Color(dynamic(0x767680, 0x767680, lightAlpha: 0.12, darkAlpha: 0.24))
    static let separator = Color(dynamic(0x3C3C43, 0xFFFFFF, lightAlpha: 0.16, darkAlpha: 0.1))
    static let positive = Color(dynamic(0x0B7651, 0x3DC58E))
    static let positiveSoft = Color(dynamic(0xE3F4EC, 0x163326))
    static let negative = Color(dynamic(0xC02F43, 0xFF7083))
    static let negativeSoft = Color(dynamic(0xFBE7EA, 0x3A1C22))
    static let negativeStrongUI = dynamic(0xB8293D, 0xC93A4F)
    static let warning = Color(dynamic(0x965A00, 0xF0A83A))
    static let warningSoft = Color(dynamic(0xFDF1DC, 0x3A2A12))
    // Пятна фона. В тёмной теме ярче, чем в вебе: карточки здесь стеклянные, им нужно что преломлять.
    static let glow1 = Color(dynamic(0x6373F0, 0x6E78FF, lightAlpha: 0.16, darkAlpha: 0.3))
    static let glow2 = Color(dynamic(0x38BDAA, 0x28AAA0, lightAlpha: 0.12, darkAlpha: 0.18))
    static let glow3 = Color(dynamic(0xF08CAA, 0xC85AA0, lightAlpha: 0.12, darkAlpha: 0.18))
    /// Оттенок стекла карточки лимита в тёмной теме — глубокий индиго под белым текстом.
    static let heroTint = Color(dynamic(0x3F51D9, 0x3A4BD0, lightAlpha: 0.9, darkAlpha: 0.62))

    /// Цвет текста/значка и мягкая подложка смыслового тона.
    static func color(_ tone: Tone) -> Color {
        switch tone {
        case .accent: accent
        case .positive: positive
        case .warning: warning
        case .negative: negative
        case .muted, .default: muted
        }
    }

    static func soft(_ tone: Tone) -> Color {
        switch tone {
        case .accent: accentSoft
        case .positive: positiveSoft
        case .warning: warningSoft
        case .negative: negativeSoft
        case .muted, .default: surface2
        }
    }
}

/// Фон страницы: bg и мягкие цветные пятна — стеклу панелей нужно что преломлять.
struct PageBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { geo in
            let side = max(geo.size.width, geo.size.height)
            ZStack {
                Theme.bg
                if !reduceTransparency {
                    Circle().fill(Theme.glow1).frame(width: side * 0.9).blur(radius: 90)
                        .position(x: 0, y: 0)
                    Circle().fill(Theme.glow2).frame(width: side * 0.7).blur(radius: 90)
                        .position(x: geo.size.width, y: geo.size.height * 0.35)
                    Circle().fill(Theme.glow3).frame(width: side * 0.8).blur(radius: 90)
                        .position(x: geo.size.width * 0.25, y: geo.size.height)
                }
            }
            // Три размытия радиусом 90 — одной готовой картинкой: иначе система пересчитывает их в каждом
            // кадре, пока поверх что-то прокручивается или движется.
            .drawingGroup()
        }
        .ignoresSafeArea()
    }
}
