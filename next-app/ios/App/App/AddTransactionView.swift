import SwiftUI

/// Окно «Новый расход / доход / перевод»: сумма → счёт → категория → «Добавить» (дизайн-код: запись траты за три
/// касания). У всех трёх видов один и тот же верх — переключение не двигает сумму и выбор счёта. Частые траты
/// заполняют форму одним касанием. Повтор и прочие параметры — в полной форме интерфейса: туда уходит всё введённое.
struct AddTransactionView: View {
    enum Kind: String { case expense, income, transfer }

    /// Модель на момент открытия; дальше — живая из HomeStore (например, после «Показать остатки» по Face ID).
    let initialAdd: HomeModel.Add
    private var add: HomeModel.Add { HomeStore.shared.model?.add ?? initialAdd }
    private var balancesHidden: Bool { HomeStore.shared.model?.balancesHidden ?? false }
    @Environment(\.dismiss) private var dismiss
    @State private var allCategories = false

    @State private var kind: Kind
    @State private var amountText = ""
    @State private var category: String
    @State private var title = ""
    @State private var date = Date()
    /// Счёт операции; у перевода — «откуда».
    @State private var accountId: String
    /// Перевод: «куда».
    @State private var toAccountId: String
    @State private var card: String?
    @State private var busy = false
    @State private var error: String?
    /// Какое поле с клавиатурой сейчас в фокусе; nil — клавиатура убрана.
    enum Field: Hashable { case amount, title }
    @FocusState private var focus: Field?

    init(add: HomeModel.Add, initialKind: Kind) {
        self.initialAdd = add
        _kind = State(initialValue: initialKind)
        _category = State(initialValue: Self.defaultCategory(add, initialKind))
        let account = Self.defaultAccount(add, initialKind)
        _accountId = State(initialValue: account)
        _toAccountId = State(initialValue: Self.firstOther(add.transferAccounts ?? [], except: account))
        _card = State(initialValue: add.accounts?.first { $0.id == account }?.lastCard)
    }

    private var payable: [HomeModel.AccountChoice] { add.accounts ?? [] }
    private var transferAccounts: [HomeModel.AccountChoice] { add.transferAccounts ?? [] }
    /// Счета, из которых выбирается «откуда» (у перевода) или счёт операции.
    private var sourceAccounts: [HomeModel.AccountChoice] { kind == .transfer ? transferAccounts : payable }
    private var fromAccount: HomeModel.AccountChoice? { sourceAccounts.first { $0.id == accountId } }
    private var toAccount: HomeModel.AccountChoice? { transferAccounts.first { $0.id == toAccountId } }

    private var accountCards: [HomeModel.CardChoice] {
        kind == .transfer ? [] : payable.first { $0.id == accountId }?.cards ?? []
    }

    private static func defaultAccount(_ add: HomeModel.Add, _ kind: Kind) -> String {
        (kind == .income ? add.lastIncomeAccount : add.lastExpenseAccount) ?? add.accounts?.first?.id ?? "main"
    }

    /// Второй счёт для перевода: сначала накопительный, иначе любой другой.
    private static func firstOther(_ accounts: [HomeModel.AccountChoice], except id: String) -> String {
        accounts.first { $0.id != id && $0.savings == true }?.id ?? accounts.first { $0.id != id }?.id ?? ""
    }

    private static func defaultCategory(_ add: HomeModel.Add, _ kind: Kind) -> String {
        switch kind {
        case .income: add.lastIncome.flatMap { add.income.contains($0) ? $0 : nil } ?? add.income.first ?? ""
        default: add.lastExpense.flatMap { add.expense.contains($0) ? $0 : nil } ?? add.expense.first ?? ""
        }
    }

    private var categories: [String] { kind == .income ? add.income : add.expense }
    /// Чипами — частые и выбранная; остальные — в списке «Все категории».
    private var shownCategories: [String] {
        let top = (kind == .income ? add.incomeTop : add.expenseTop) ?? []
        guard !top.isEmpty, categories.count > top.count + 2 else { return categories }
        var list = category.isEmpty || top.contains(category) ? [] : [category]
        list += top.filter { categories.contains($0) }
        return list
    }
    /// Перевод — только когда своих счетов несколько.
    private var canTransfer: Bool { transferAccounts.count > 1 }
    private var repays: Bool { kind == .transfer && toAccount?.credit == true }
    /// Сумма крупными цифрами, но длинная — мельче, чтобы не вылезать за край.
    private var amountFontSize: CGFloat { amountText.count > 11 ? 30 : amountText.count > 8 ? 36 : 44 }

    /// Сумма в копейках: «1 234,5» → 123450. nil — пусто или не число.
    private var amount: Int? {
        let cleaned = amountText
            .replacingOccurrences(of: "\u{00a0}", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ",", with: ".")
        guard !cleaned.isEmpty, let value = Decimal(string: cleaned, locale: Locale(identifier: "en_US_POSIX")), value > 0 else {
            return nil
        }
        var kopecks = value * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &kopecks, 0, .plain)
        let result = NSDecimalNumber(decimal: rounded).intValue
        return result > 0 ? result : nil
    }

    /// Обязательное заполнено: сумма и категория (у перевода — два разных счёта). До этого кнопки нет совсем.
    private var ready: Bool {
        guard amount != nil else { return false }
        if kind == .transfer { return fromAccount != nil && toAccount != nil && accountId != toAccountId }
        return !category.isEmpty
    }
    private var canSave: Bool { ready && !busy }
    private var actionTitle: String { kind == .transfer ? (repays ? "Погасить" : "Перевести") : "Добавить" }
    private var screenTitle: String {
        switch kind {
        case .expense: "Новый расход"
        case .income: "Новый доход"
        case .transfer: repays ? "Погасить кредитку" : "Перевод"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Picker("Вид операции", selection: $kind) {
                        Text("Расход").tag(Kind.expense)
                        Text("Доход").tag(Kind.income)
                        if canTransfer { Text("Перевод").tag(Kind.transfer) }
                    }
                    .pickerStyle(.segmented)

                    amountField

                    // Счёт — одной строкой у всех видов: строка не меняет высоту при переключении.
                    if kind == .transfer {
                        accountField("Откуда", accounts: transferAccounts, selection: Binding(
                            get: { accountId },
                            set: { id in
                                accountId = id
                                if id == toAccountId { toAccountId = Self.firstOther(transferAccounts, except: id) }
                            }
                        ), delta: -(amount ?? 0), eye: true)
                        accountField("Куда", accounts: transferAccounts.filter { $0.id != accountId }, selection: $toAccountId, delta: amount ?? 0, eye: false)
                    } else if payable.count > 1 {
                        accountField(kind == .income ? "На какой счёт" : "С какого счёта", accounts: payable, selection: Binding(
                            get: { accountId },
                            set: { id in
                                accountId = id
                                card = payable.first { $0.id == id }?.lastCard
                            }
                        ), delta: kind == .income ? (amount ?? 0) : -(amount ?? 0), eye: true)
                    }

                    if !accountCards.isEmpty {
                        section("Карта") {
                            FlowLayout(spacing: 8) {
                                ForEach([nil] + accountCards.map { Optional($0) }, id: \.?.digits) { choice in
                                    chip(choice?.label ?? "Без карты", selected: card == choice?.digits) {
                                        card = choice?.digits
                                    }
                                }
                            }
                        }
                    }

                    if kind == .transfer {
                        Text(transferHint)
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                            .padding(.top, -12)
                    } else {
                        section("Категория") {
                            FlowLayout(spacing: 8) {
                                ForEach(shownCategories, id: \.self) { item in
                                    chip(item, selected: item == category) { category = item }
                                }
                                if shownCategories.count < categories.count {
                                    Button("Все категории (\(categories.count))") { allCategories = true }
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(Theme.accent)
                                        .padding(.horizontal, 10)
                                        .frame(minHeight: 40)
                                }
                            }
                        }
                    }

                    // Частые траты — после категорий: верх окна одинаков у расхода и дохода.
                    if kind == .expense, !add.picks.isEmpty {
                        section("Частые") {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(add.picks, id: \.self) { pick in
                                        Button {
                                            amountText = formatForInput(pick.amount)
                                            category = pick.category
                                            title = pick.title == pick.category ? "" : pick.title
                                            UISelectionFeedbackGenerator().selectionChanged()
                                        } label: {
                                            VStack(alignment: .leading, spacing: 1) {
                                                Text(pick.title).font(.subheadline.weight(.medium)).lineLimit(1)
                                                Text(pick.amountText).font(.caption).monospacedDigit().foregroundStyle(Theme.muted)
                                            }
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 7)
                                            .frame(minHeight: 44)
                                            .background(Theme.fill, in: .rect(cornerRadius: 16, style: .continuous))
                                        }
                                        .buttonStyle(PressableStyle())
                                        .foregroundStyle(Theme.text)
                                    }
                                }
                                .padding(.horizontal, 20)
                            }
                            .padding(.horizontal, -20)
                        }
                    }

                    section("Описание") {
                        TextField(kind == .expense ? "Например, кофе" : kind == .income ? "Например, аванс" : "Необязательно", text: $title)
                            .focused($focus, equals: .title)
                            .submitLabel(.done)
                            .textInputAutocapitalization(.sentences)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 48)
                            .background(Theme.fill, in: .rect(cornerRadius: 16, style: .continuous))
                    }

                    DatePicker("Дата", selection: $date, displayedComponents: .date)
                        .font(.subheadline)
                        .environment(\.locale, Locale(identifier: "ru_RU"))

                    if kind != .transfer {
                        Button {
                            openFullForm(kind)
                        } label: {
                            Label("Повтор и другие параметры", systemImage: "slider.horizontal.3")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(Theme.accent)
                        .frame(minHeight: 44)
                    }

                    if let error {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(Theme.negative)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(20)
                // Переключение вида — плавно: поля ниже появляются и исчезают, а не прыгают.
                .animation(.snappy(duration: 0.25), value: kind)
                // Нажатие на свободное место (не на поле и не на кнопку) убирает клавиатуру.
                .background {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { focus = nil }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // Фон — и под клавиатурой, иначе над ней видна белая полоса.
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(screenTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
                // Над клавиатурой: убрать её и сразу добавить — большая кнопка внизу в это время спрятана.
                ToolbarItemGroup(placement: .keyboard) {
                    Button("Готово") { focus = nil }
                    Spacer()
                    if ready {
                        Button(actionTitle, action: save)
                            .fontWeight(.semibold)
                            .disabled(busy)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if focus == nil && (ready || busy) {
                    Button(action: save) {
                        Group {
                            if busy {
                                ProgressView()
                            } else {
                                Text(actionTitle).font(.body.weight(.semibold))
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Theme.action)
                    .disabled(!canSave)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.2), value: focus == nil && ready)
            .onChange(of: kind) { previous, next in
                switchKind(from: previous, to: next)
            }
            .onAppear { focus = .amount }
            .sheet(isPresented: $allCategories) {
                CategoryList(categories: categories, selected: category) { picked in
                    category = picked
                    UISelectionFeedbackGenerator().selectionChanged()
                }
                .presentationDetents([.medium, .large])
            }
        }
        .presentationBackground(Theme.bg)
    }

    /// Смена вида: сумма, описание и дата остаются; счёт — по смыслу (расход ушёл с него, доход пришёл на него).
    private func switchKind(from previous: Kind, to next: Kind) {
        if next == .transfer {
            if previous == .income {
                toAccountId = accountId
                accountId = Self.firstOther(transferAccounts, except: accountId)
            } else if accountId == toAccountId || toAccount == nil {
                toAccountId = Self.firstOther(transferAccounts, except: accountId)
            }
            return
        }
        if previous == .transfer {
            let own = next == .income ? toAccountId : accountId
            accountId = payable.contains { $0.id == own } ? own : Self.defaultAccount(add, next)
            card = payable.first { $0.id == accountId }?.lastCard
        }
        if !categories.contains(category) { category = Self.defaultCategory(add, next) }
    }

    private var transferHint: String {
        if toAccount?.savings == true && fromAccount?.savings != true { return "Пополнение сбережений — считается отложенным в этом месяце." }
        if fromAccount?.savings == true && toAccount?.savings != true { return "Снятие из сбережений на счёт." }
        if repays { return "Погашение кредитки — перевод: покупки по ней уже учтены, когда вы их делали." }
        return "Перевод между своими счетами — не доход и не расход."
    }

    private var amountField: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            TextField("0", text: $amountText)
                .keyboardType(.decimalPad)
                .font(.system(size: amountFontSize, weight: .bold))
                .monospacedDigit()
                .focused($focus, equals: .amount)
                // По ширине числа (пустое — по «0»): «₽» стоит сразу за суммой, а не у правого края.
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel("Сумма в рублях")
            Text("₽")
                .font(.system(size: amountFontSize, weight: .bold))
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private func chip(_ text: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            action()
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            Text(text)
                .lineLimit(1)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .foregroundStyle(selected ? .white : Theme.text)
                .background(selected ? Theme.action : Theme.fill, in: .capsule)
        }
        .buttonStyle(PressableStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        section(title, trailing: { EmptyView() }, content: content)
    }

    private func section<Trailing: View, Content: View>(
        _ title: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                Spacer(minLength: 8)
                trailing()
            }
            .frame(minHeight: 20)
            content()
        }
    }

    /// Счёт — строкой: выбранный счёт и сколько на нём, по нажатию — меню со всеми счетами. Под строкой —
    /// «было → станет» с учётом суммы (если суммы не спрятаны глазком).
    private func accountField(
        _ title: String,
        accounts: [HomeModel.AccountChoice],
        selection: Binding<String>,
        delta: Int,
        eye: Bool
    ) -> some View {
        let selected = accounts.first { $0.id == selection.wrappedValue } ?? accounts.first
        return section(title, trailing: { if eye { BalancesEye(hidden: balancesHidden) } }) {
            VStack(alignment: .leading, spacing: 6) {
                Menu {
                    Picker(title, selection: Binding(
                        get: { selection.wrappedValue },
                        set: { id in
                            selection.wrappedValue = id
                            UISelectionFeedbackGenerator().selectionChanged()
                        }
                    )) {
                        ForEach(accounts) { account in
                            Label(account.funds(short: true).map { "\(account.name) · \($0.text)" } ?? account.name, systemImage: account.symbol)
                                .tag(account.id)
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: selected?.symbol ?? "creditcard").foregroundStyle(Theme.accent)
                        Text(selected?.name ?? "Выберите счёт").lineLimit(1).foregroundStyle(Theme.text)
                        Spacer(minLength: 8)
                        if let funds = selected?.funds(short: true) {
                            Text(funds.text).monospacedDigit().lineLimit(1).foregroundStyle(Theme.muted)
                        }
                        Image(systemName: "chevron.up.chevron.down").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .font(.subheadline)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 48)
                    .background(Theme.fill, in: .rect(cornerRadius: 16, style: .continuous))
                }
                if let selected, let before = selected.funds() {
                    // «Сбербанк: 50 000 ₽ → 48 500 ₽» — сколько станет после операции.
                    let after = selected.funds(delta: delta)
                    let changes = delta != 0 && after?.text != before.text
                    (Text(before.text)
                        + Text(changes ? " → \(after?.text ?? "")" : "")
                        + Text(changes && after?.negative == true ? (selected.credit == true ? " — больше лимита" : " — не хватает") : ""))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(changes && after?.negative == true ? Theme.negative : Theme.muted)
                }
            }
        }
    }

    /// Полная форма интерфейса (повтор, обязательность) — со всем, что уже введено здесь.
    private func openFullForm(_ type: Kind) {
        var preset: [String: JSONValue] = ["type": .string(type.rawValue), "date": .string(WidgetSnapshot.today(date))]
        if let amount { preset["amount"] = .number(Double(amount)) }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanTitle.isEmpty { preset["title"] = .string(cleanTitle) }
        if !category.isEmpty { preset["category"] = .string(category) }
        preset["accountId"] = .string(accountId)
        if let card { preset["card"] = .string(card) }
        dismiss()
        AppShell.shared.open(["kind": .string("tx"), "preset": .object(preset)])
    }

    private func formatForInput(_ kopecks: Int) -> String {
        kopecks % 100 == 0 ? "\(kopecks / 100)" : String(format: "%d,%02d", kopecks / 100, kopecks % 100)
    }

    private func save() {
        guard let amount, ready, !busy else { return }
        busy = true
        error = nil
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let command: JSONValue
        if kind == .transfer {
            command = .command("transfer", ["draft": .object([
                "amount": .number(Double(amount)),
                "from": .string(accountId),
                "to": .string(toAccountId),
                "title": .string(cleanTitle),
                "date": .string(WidgetSnapshot.today(date)),
            ])])
        } else {
            let draft: [String: JSONValue] = [
                "kind": .string(kind.rawValue),
                "amount": .number(Double(amount)),
                "category": .string(category),
                "title": .string(cleanTitle),
                "date": .string(WidgetSnapshot.today(date)),
            ]
            .merging(payable.count > 1 ? ["accountId": .string(accountId)] : [:]) { current, _ in current }
            .merging(card.map { ["card": .string($0)] } ?? [:]) { current, _ in current }
            command = .command("add", ["draft": .object(draft)])
        }
        Task {
            let result = await AppShell.shared.send(command)
            busy = false
            guard result.ok else {
                error = result.error
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
            let undo = result.txId.map { id in
                ToastCenter.Action(label: "Отменить") {
                    Task { await AppShell.shared.perform(.command("undo", ["txId": .string(id)])) }
                }
            }
            ToastCenter.shared.show(result.message ?? "Добавлено", action: undo)
        }
    }
}

/// Все категории — списком с поиском (когда чипами видны только частые).
private struct CategoryList: View {
    let categories: [String]
    let selected: String
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [String] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? categories : categories.filter { $0.lowercased().contains(needle) }
    }

    var body: some View {
        NavigationStack {
            List(filtered, id: \.self) { item in
                Button {
                    onPick(item)
                    dismiss()
                } label: {
                    HStack {
                        Text(item).foregroundStyle(Theme.text)
                        Spacer()
                        if item == selected { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                    }
                }
            }
            .searchable(text: $query, prompt: "Найти категорию")
            .navigationTitle("Категория")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }
}

/// Раскладка «по строкам с переносом» — для чипов категорий.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    /// Размер чипа: свой, но не шире строки — длинное название обрезается многоточием, а не вылезает за край.
    private func fitted(_ view: LayoutSubview, _ width: CGFloat) -> CGSize {
        let ideal = view.sizeThatFits(.unspecified)
        return ideal.width <= width ? ideal : view.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = fitted(view, width)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxX, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = fitted(view, bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
