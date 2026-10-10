import SwiftUI

/// Нативная Главная. Порядок блоков — по дизайн-коду (docs/design-code.md, §4): лимит на сегодня,
/// «Требует внимания», быстрые траты, счёт и сбережения, месяц, «Скоро», последние операции.
struct HomeScreen: View {
    private let store = HomeStore.shared

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    Group {
                        if let model = store.model {
                            HomeContent(model: model)
                        } else {
                            ProgressView()
                                .frame(maxWidth: .infinity, minHeight: 300)
                                .accessibilityLabel("Загрузка")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 32)
                    .id("top")
                }
                .onReceive(NotificationCenter.default.publisher(for: .homeScrollToTop)) { _ in
                    withAnimation { proxy.scrollTo("top", anchor: .top) }
                }
            }
            .background { PageBackground() }
            .refreshable { await AppShell.shared.perform(.command("refresh"), quiet: true) }
            .navigationTitle("Бюджет")
            .navigationSubtitle(store.model?.sync.text ?? "")
            .toolbar {
                if store.model?.assistant == true {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            AppShell.shared.open(["kind": .string("ai")])
                        } label: {
                            SiriOrbIcon().frame(width: 26, height: 26)
                        }
                        .accessibilityLabel("AI-помощник")
                    }
                    ToolbarSpacer(.fixed, placement: .topBarTrailing)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        AppShell.shared.setTab("settings")
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Настройки")
                }
            }
        }
    }
}

private struct HomeContent: View {
    let model: HomeModel

    var body: some View {
        VStack(spacing: 16) {
            if model.hasData, let today = model.today {
                if today.kind == "limit" {
                    TodayCard(today: today)
                } else {
                    BalancePrompt(text: today.text ?? "")
                }
            }
            if !model.attention.isEmpty {
                AttentionCard(rows: model.attention)
            }
            if let onboarding = model.onboarding {
                OnboardingCard(onboarding: onboarding)
            }
            if !model.quick.isEmpty {
                QuickSpend(picks: model.quick)
            }
            if let tiles = model.tiles {
                Tiles(tiles: tiles)
            }
            if let month = model.month {
                MonthCard(month: month)
            }
            if model.hasData {
                UpcomingCard(events: model.upcoming)
                RecentCard(rows: model.recent)
            }
        }
        .animation(.smooth(duration: 0.3), value: model)
    }
}

// MARK: - Общие элементы

/// Карточка контента: заголовок, одно действие справа, без размытия (стекло — только у навигации).
struct HomeCard<Content: View, Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                trailing
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

extension View {
    /// Подложка карточки — полупрозрачное системное стекло Liquid Glass. При «Уменьшить прозрачность»
    /// система сама делает его плотным.
    func glassCard(tint: Color? = nil, interactive: Bool = false) -> some View {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glassEffect(glass, in: .rect(cornerRadius: 28, style: .continuous))
    }
}

extension HomeCard where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = EmptyView()
        self.content = content()
    }
}

/// Текстовая кнопка в заголовке карточки («Подробнее», «Все 7»).
struct LinkButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .frame(minHeight: 44)
            .contentShape(.rect)
    }
}

/// Кнопка действия в строке: основная (заливка accent) или вторичная (подложка).
struct ActionButton: View {
    let action: HomeModel.Action

    var body: some View {
        Button {
            Task { await AppShell.shared.perform(action.command) }
        } label: {
            Text(action.label)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .foregroundStyle(action.primary ? .white : Theme.text)
                .background(action.primary ? Theme.action : Theme.fill, in: .capsule)
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
    }
}

/// Нажатие с лёгким «вдавливанием», как у системных строк.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}

// MARK: - Лимит на сегодня

private struct TodayCard: View {
    let today: HomeModel.Today
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 12) {
                Text(today.label ?? "")
                    .font(.subheadline)
                    .opacity(0.9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let status = today.status {
                    Text(status.text)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .foregroundStyle(Theme.color(status.tone))
                        .background(Theme.soft(status.tone), in: .capsule)
                }
            }
            Text(today.amount ?? "")
                .font(.system(size: 40, weight: .bold))
                .monospacedDigit()
                .tracking(-0.5)
                .contentTransition(.numericText())
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let detail = today.detail {
                Text(detail).font(.subheadline).opacity(0.9)
            }
            if let gap = today.gap {
                Text(gap)
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.black.opacity(0.15), in: .rect(cornerRadius: 16, style: .continuous))
                    .padding(.top, 8)
            }
            HStack(spacing: 8) {
                CardButton(title: "Расход", symbol: "plus") {
                    AppShell.shared.root?.presentAdd(kind: .expense)
                }
                CardButton(title: "Как посчитано", symbol: "info.circle") {
                    AppShell.shared.open(["kind": .string("explain")])
                }
            }
            .padding(.top, 12)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(.white)
        .modifier(HeroSurface(dark: colorScheme == .dark))
        .accessibilityElement(children: .contain)
    }
}

/// Подложка карточки лимита. Светлая тема — фирменный градиент; тёмная — стекло с глубоким индиго-оттенком:
/// светлый сиреневый градиент на тёмном фоне выглядел блёкло.
private struct HeroSurface: ViewModifier {
    let dark: Bool

    func body(content: Content) -> some View {
        if dark {
            content.glassCard(tint: Theme.heroTint)
        } else {
            content
                .background(
                    LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: .rect(cornerRadius: 28, style: .continuous)
                )
                .shadow(color: Theme.accent.opacity(0.35), radius: 18, y: 10)
        }
    }
}

private struct CardButton: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .background(.white.opacity(0.16), in: .capsule)
        }
        .buttonStyle(PressableStyle())
        .frame(minHeight: 44)
    }
}

private struct BalancePrompt: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(text).font(.body.weight(.medium))
            Button {
                AppShell.shared.open(["kind": .string("balance")])
            } label: {
                Label("Указать остаток", systemImage: "wallet.bifold")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .foregroundStyle(.white)
                    .background(Theme.action, in: .capsule)
            }
            .buttonStyle(PressableStyle())
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(tint: Theme.accent.opacity(0.18))
    }
}

// MARK: - Требует внимания

private struct AttentionCard: View {
    let rows: [HomeModel.Attention]

    var body: some View {
        HomeCard(title: "Требует внимания") {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().overlay(Theme.separator) }
                    AttentionRow(row: row)
                }
            }
        }
    }
}

private struct AttentionRow: View {
    let row: HomeModel.Attention

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let command = row.command {
                Button {
                    Task { await AppShell.shared.perform(command) }
                } label: {
                    content(chevron: true)
                }
                .buttonStyle(PressableStyle())
            } else {
                content(chevron: false)
            }
            if !row.actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(row.actions, id: \.label) { ActionButton(action: $0) }
                }
                .padding(.leading, 48)
            }
        }
        .padding(.vertical, 6)
    }

    private func content(chevron: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: row.symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.color(row.tone))
                .frame(width: 36, height: 36)
                .background(Theme.soft(row.tone), in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.text)
                if let text = row.text {
                    Text(text).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 48)
        .contentShape(.rect)
    }
}

// MARK: - Первые шаги

private struct OnboardingCard: View {
    let onboarding: HomeModel.Onboarding

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Начнём планировать").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                Text("Готово \(onboarding.done) из 3").font(.subheadline).foregroundStyle(Theme.muted)
            }
            if let intro = onboarding.intro {
                Text(intro).font(.subheadline).foregroundStyle(Theme.muted)
            }
            ForEach(Array(onboarding.steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle().fill(step.done ? Theme.positiveSoft : Theme.accentSoft)
                        if step.done {
                            Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(Theme.positive)
                        } else {
                            Text("\(index + 1)").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                        }
                    }
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(step.title)
                            .font(.body.weight(.medium))
                            .strikethrough(step.done)
                            .foregroundStyle(step.done ? Theme.muted : Theme.text)
                        if step.done {
                            Text(step.doneText).font(.footnote).foregroundStyle(Theme.muted)
                        } else {
                            HStack(spacing: 8) {
                                ForEach(step.actions, id: \.label) { ActionButton(action: $0) }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(step.done ? "Выполнено: \(step.title)" : "Шаг \(index + 1): \(step.title)")
                }
            }
            if onboarding.importHint {
                Button {
                    AppShell.shared.setTab("settings")
                } label: {
                    (Text("Есть данные из старой версии? Импортируйте файл в разделе ")
                        + Text("Настройки → Данные").foregroundStyle(Theme.accent).fontWeight(.medium))
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

// MARK: - Быстрые траты

private struct QuickSpend: View {
    let picks: [HomeModel.Quick]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Быстрые траты — одним касанием")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                GlassEffectContainer(spacing: 8) {
                    HStack(spacing: 8) {
                        ForEach(picks) { pick in
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                Task {
                                    let result = await AppShell.shared.perform(.command("quick", ["key": .string(pick.key)]))
                                    if result.ok { UINotificationFeedbackGenerator().notificationOccurred(.success) }
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(pick.title).font(.subheadline.weight(.medium)).lineLimit(1)
                                    Text(pick.amount).font(.caption).monospacedDigit().foregroundStyle(Theme.muted)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .frame(minHeight: 48)
                                .foregroundStyle(Theme.text)
                            }
                            .buttonStyle(.plain)
                            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16, style: .continuous))
                            .accessibilityLabel("Добавить расход: \(pick.title), \(pick.amount)")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 2)
                }
            }
            .padding(.horizontal, -16)
            .scrollClipDisabled()
        }
    }
}

// MARK: - Счёт и сбережения

private struct Tiles: View {
    let tiles: HomeModel.Tiles

    var body: some View {
        HStack(spacing: 12) {
            Tile(symbol: "wallet.bifold", title: "На счёте", amount: tiles.balance, negative: tiles.balanceNegative, hint: tiles.balanceHint) {
                AppShell.shared.open(["kind": .string("balance")])
            }
            Tile(symbol: "banknote", title: "Сбережения", amount: tiles.savings, negative: false, hint: "Пополнить или снять") {
                AppShell.shared.open(["kind": .string("savings"), "direction": .string("in")])
            }
        }
    }
}

private struct Tile: View {
    let symbol: String
    let title: String
    let amount: String
    let negative: Bool
    let hint: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Label(title, systemImage: symbol)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                Text(amount)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(negative ? Theme.negative : Theme.text)
                Text(hint).font(.caption).foregroundStyle(Theme.muted)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect(cornerRadius: 28, style: .continuous))
            .glassCard(interactive: true)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Месяц

private struct MonthCard: View {
    let month: HomeModel.Month

    var body: some View {
        HomeCard(title: month.title) {
            LinkButton(title: "Подробнее") { AppShell.shared.setTab("analytics") }
        } content: {
            HStack(alignment: .lastTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(month.label).font(.subheadline).foregroundStyle(Theme.muted)
                    Text(month.amount)
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(month.negative ? Theme.negative : Theme.text)
                }
                Spacer()
                Text(month.of).font(.subheadline).foregroundStyle(Theme.muted)
            }
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: min(month.progress, 1))
                    .tint(Theme.color(month.tone))
                    .accessibilityLabel("Использовано гибкого бюджета")
                    .accessibilityValue("\(Int((month.progress * 100).rounded())) %")
                if let daysLeft = month.daysLeft {
                    Text(daysLeft).font(.caption).foregroundStyle(Theme.muted)
                }
            }
        }
    }
}

// MARK: - Скоро

private struct UpcomingCard: View {
    let events: [HomeModel.Upcoming]
    @State private var expanded = false
    private let preview = 3

    var body: some View {
        HomeCard(title: "Скоро") {
            if events.count > preview {
                LinkButton(title: expanded ? "Свернуть" : "Все \(events.count)") {
                    withAnimation(.smooth) { expanded.toggle() }
                }
            }
        } content: {
            if events.isEmpty {
                Text("Запланированных платежей нет. Добавьте регулярные доходы и расходы на вкладке «Регулярные» — и здесь появится прогноз остатка.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(expanded ? events : Array(events.prefix(preview))) { event in
                        UpcomingRow(event: event)
                    }
                }
            }
        }
    }
}

private struct UpcomingRow: View {
    let event: HomeModel.Upcoming

    var body: some View {
        let content = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.subheadline).foregroundStyle(Theme.text).lineLimit(1)
                (Text("\(event.when) · ") + Text(event.after).foregroundStyle(event.afterNegative ? Theme.negative : Theme.muted))
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(event.amount)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(event.positive ? Theme.positive : Theme.text)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(.rect)

        if let command = event.command {
            Button {
                Task { await AppShell.shared.perform(command) }
            } label: { content }
                .buttonStyle(PressableStyle())
        } else {
            content
        }
    }
}

// MARK: - Последние операции

private struct RecentCard: View {
    let rows: [HomeModel.Recent]

    var body: some View {
        HomeCard(title: "Последние операции") {
            LinkButton(title: "Вся история") { AppShell.shared.setTab("history") }
        } content: {
            if rows.isEmpty {
                Text("Пока нет операций.").font(.subheadline).foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(rows) { RecentRow(row: $0) }
                }
            }
        }
    }
}

private struct RecentRow: View {
    let row: HomeModel.Recent

    var body: some View {
        Button {
            Task { await AppShell.shared.perform(row.command) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: row.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.color(row.tint))
                    .frame(width: 40, height: 40)
                    .background(Theme.soft(row.tint), in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(row.subtitle).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(row.amount)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(row.amountTone == .positive ? Theme.positive : row.amountTone == .negative ? Theme.negative : Theme.text)
                    if let autoSaving = row.autoSaving {
                        Text("\(autoSaving) в копилку").font(.caption).monospacedDigit().foregroundStyle(Theme.muted)
                    }
                }
            }
            .padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(PressableStyle())
    }
}

// MARK: - Значок помощника

/// Стеклянный серый «шар» в духе Siri из iOS 27: серебристый перелив под стеклом.
struct SiriOrbIcon: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let angle = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) / 6 * 360
            ZStack {
                Circle()
                    .fill(AngularGradient(
                        colors: [0.96, 0.62, 0.88, 0.5, 0.8, 0.58, 0.96].map { Color(white: $0) },
                        center: .center,
                        angle: .degrees(angle)
                    ))
                    .blur(radius: 2.5)
                Circle()
                    .fill(RadialGradient(colors: [.white.opacity(0.75), .clear], center: .init(x: 0.32, y: 0.28), startRadius: 0, endRadius: 9))
                Circle().strokeBorder(.white.opacity(0.55), lineWidth: 0.75)
            }
            .clipShape(.circle)
            .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
        }
        .accessibilityHidden(true)
    }
}
