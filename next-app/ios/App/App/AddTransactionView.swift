import SwiftUI

/// Окно «Новый расход / доход»: сумма → категория → «Добавить» (дизайн-код: запись траты за три касания).
/// Частые траты заполняют форму одним касанием. Перевод, повтор и прочие параметры — в полной форме интерфейса:
/// туда уходит всё введённое здесь (сумма, категория, описание, дата, счёт), ничего не теряется.
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
    @State private var accountId: String
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
        _card = State(initialValue: add.accounts?.first { $0.id == account }?.lastCard)
    }

    private var accountCards: [HomeModel.CardChoice] {
        add.accounts?.first { $0.id == accountId }?.cards ?? []
    }

    private static func defaultAccount(_ add: HomeModel.Add, _ kind: Kind) -> String {
        (kind == .income ? add.lastIncomeAccount : add.lastExpenseAccount) ?? add.accounts?.first?.id ?? "main"
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
    private var canTransfer: Bool { (add.accounts?.count ?? 0) > 1 }
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

    /// Обязательное заполнено: сумма и категория. До этого кнопки «Добавить» нет совсем.
    private var ready: Bool { amount != nil && !category.isEmpty }
    private var canSave: Bool { ready && !busy }

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

                    if let accounts = add.accounts, accounts.count > 4 {
                        section(kind == .income ? "На какой счёт" : "С какого счёта", trailing: { BalancesEye(hidden: balancesHidden) }) {
                            accountMenu(accounts)
                        }
                    } else if let accounts = add.accounts, accounts.count > 1 {
                        section(kind == .income ? "На какой счёт" : "С какого счёта", trailing: { BalancesEye(hidden: balancesHidden) }) {
                            FlowLayout(spacing: 8) {
                                ForEach(accounts) { account in
                                    let selected = account.id == accountId
                                    Button {
                                        accountId = account.id
                                        card = account.lastCard
                                        UISelectionFeedbackGenerator().selectionChanged()
                                    } label: {
                                        HStack(spacing: 6) {
                                            Label(account.name, systemImage: account.symbol).lineLimit(1)
                                            // Сколько на счёте (если суммы не спрятаны глазком).
                                            if let funds = account.funds(short: true) {
                                                Text(funds.text)
                                                    .monospacedDigit()
                                                    .lineLimit(1)
                                                    .foregroundStyle(selected ? .white.opacity(0.8) : Theme.muted)
                                            }
                                        }
                                            .font(.subheadline.weight(selected ? .semibold : .regular))
                                            .padding(.horizontal, 14)
                                            .frame(minHeight: 40)
                                            .foregroundStyle(selected ? .white : Theme.text)
                                            .background(selected ? Theme.action : Theme.fill, in: .capsule)
                                    }
                                    .buttonStyle(PressableStyle())
                                    .accessibilityAddTraits(selected ? .isSelected : [])
                                }
                            }
                        }
                    }

                    if let account = add.accounts?.first(where: { $0.id == accountId }),
                       let before = account.funds(), (add.accounts?.count ?? 0) > 1 {
                        // «Сбербанк: 50 000 ₽ → 48 500 ₽» — сколько станет после операции.
                        let after = account.funds(delta: kind == .income ? (amount ?? 0) : -(amount ?? 0))
                        let changes = amount != nil && after?.text != before.text
                        (Text("\(account.name): ").foregroundStyle(Theme.text)
                            + Text(before.text)
                            + Text(changes ? " → \(after?.text ?? "")" : "")
                            + Text(changes && after?.negative == true ? (account.credit == true ? " — больше лимита" : " — не хватает") : ""))
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(changes && after?.negative == true ? Theme.negative : Theme.muted)
                            .padding(.top, -16)
                    }

                    if !accountCards.isEmpty {
                        section("Карта") {
                            FlowLayout(spacing: 8) {
                                ForEach([nil] + accountCards.map { Optional($0) }, id: \.?.digits) { choice in
                                    let selected = card == choice?.digits
                                    Button {
                                        card = choice?.digits
                                        UISelectionFeedbackGenerator().selectionChanged()
                                    } label: {
                                        Text(choice?.label ?? "Без карты")
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
                            }
                        }
                    }

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

                    section("Категория") {
                        FlowLayout(spacing: 8) {
                            ForEach(shownCategories, id: \.self) { item in
                                let selected = item == category
                                Button {
                                    category = item
                                    UISelectionFeedbackGenerator().selectionChanged()
                                } label: {
                                    Text(item)
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
                            if shownCategories.count < categories.count {
                                Button("Все категории (\(categories.count))") { allCategories = true }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.accent)
                                    .padding(.horizontal, 10)
                                    .frame(minHeight: 40)
                            }
                        }
                    }

                    section("Описание") {
                        TextField(kind == .expense ? "Например, кофе" : "Например, аванс", text: $title)
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

                    Button {
                        openFullForm(kind)
                    } label: {
                        Label("Повтор и другие параметры", systemImage: "slider.horizontal.3")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(Theme.accent)
                    .frame(minHeight: 44)

                    if let error {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(Theme.negative)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(20)
                // Нажатие на свободное место (не на поле и не на кнопку) убирает клавиатуру.
                .background {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { focus = nil }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle(kind == .expense ? "Новый расход" : "Новый доход")
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
                        Button("Добавить", action: save)
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
                            Text("Добавить").font(.body.weight(.semibold))
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
                // Перевод — в полной форме, с уже введённой суммой, датой и счётом.
                if next == .transfer {
                    openFullForm(.transfer, previous: previous)
                    return
                }
                // Сумма, описание, дата и выбранный счёт остаются; категория — если её нет у нового вида.
                if !categories.contains(category) { category = Self.defaultCategory(add, next) }
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

    /// Счетов много — строка с выбранным счётом (и сколько на нём), выбор — меню со всеми счетами.
    private func accountMenu(_ accounts: [HomeModel.AccountChoice]) -> some View {
        let selected = accounts.first { $0.id == accountId } ?? accounts[0]
        return Menu {
            Picker("Счёт", selection: Binding(
                get: { accountId },
                set: { id in
                    accountId = id
                    card = accounts.first { $0.id == id }?.lastCard
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
                Image(systemName: selected.symbol).foregroundStyle(Theme.accent)
                Text(selected.name).lineLimit(1).foregroundStyle(Theme.text)
                Spacer(minLength: 8)
                if let funds = selected.funds(short: true) {
                    Text(funds.text).monospacedDigit().lineLimit(1).foregroundStyle(Theme.muted)
                }
                Image(systemName: "chevron.up.chevron.down").font(.footnote).foregroundStyle(Theme.muted)
            }
            .font(.subheadline)
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(Theme.fill, in: .rect(cornerRadius: 16, style: .continuous))
        }
    }

    /// Полная форма интерфейса (перевод, повтор, обязательность) — со всем, что уже введено здесь.
    private func openFullForm(_ type: Kind, previous: Kind? = nil) {
        var preset: [String: JSONValue] = ["type": .string(type.rawValue), "date": .string(WidgetSnapshot.today(date))]
        if let amount { preset["amount"] = .number(Double(amount)) }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanTitle.isEmpty { preset["title"] = .string(cleanTitle) }
        if type == .transfer {
            // Расход — деньги ушли с этого счёта, доход — пришли на него.
            preset[previous == .income ? "to" : "from"] = .string(accountId)
        } else {
            if !category.isEmpty { preset["category"] = .string(category) }
            preset["accountId"] = .string(accountId)
            if let card { preset["card"] = .string(card) }
        }
        dismiss()
        AppShell.shared.open(["kind": .string("tx"), "preset": .object(preset)])
    }

    private func formatForInput(_ kopecks: Int) -> String {
        kopecks % 100 == 0 ? "\(kopecks / 100)" : String(format: "%d,%02d", kopecks / 100, kopecks % 100)
    }

    private func save() {
        guard let amount, !category.isEmpty, !busy else { return }
        busy = true
        error = nil
        let draft: [String: JSONValue] = [
            "kind": .string(kind.rawValue),
            "amount": .number(Double(amount)),
            "category": .string(category),
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "date": .string(WidgetSnapshot.today(date)),
        ]
        .merging((add.accounts?.count ?? 0) > 1 ? ["accountId": .string(accountId)] : [:]) { current, _ in current }
        .merging(card.map { ["card": .string($0)] } ?? [:]) { current, _ in current }
        Task {
            let result = await AppShell.shared.send(.command("add", ["draft": .object(draft)]))
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
