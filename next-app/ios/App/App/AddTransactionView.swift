import SwiftUI

/// Окно «Новый расход / доход»: сумма → категория → «Добавить» (дизайн-код: запись траты за три касания).
/// Частые траты заполняют форму одним касанием. Повтор и прочие параметры — в полной форме интерфейса.
struct AddTransactionView: View {
    enum Kind: String { case expense, income }

    let add: HomeModel.Add
    @Environment(\.dismiss) private var dismiss

    @State private var kind: Kind
    @State private var amountText = ""
    @State private var category: String
    @State private var title = ""
    @State private var date = Date()
    @State private var busy = false
    @State private var error: String?
    @FocusState private var amountFocused: Bool

    init(add: HomeModel.Add, initialKind: Kind) {
        self.add = add
        _kind = State(initialValue: initialKind)
        _category = State(initialValue: Self.defaultCategory(add, initialKind))
    }

    private static func defaultCategory(_ add: HomeModel.Add, _ kind: Kind) -> String {
        switch kind {
        case .expense: add.lastExpense.flatMap { add.expense.contains($0) ? $0 : nil } ?? add.expense.first ?? ""
        case .income: add.lastIncome.flatMap { add.income.contains($0) ? $0 : nil } ?? add.income.first ?? ""
        }
    }

    private var categories: [String] { kind == .expense ? add.expense : add.income }

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

    private var canSave: Bool { amount != nil && !category.isEmpty && !busy }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Picker("Вид операции", selection: $kind) {
                        Text("Расход").tag(Kind.expense)
                        Text("Доход").tag(Kind.income)
                    }
                    .pickerStyle(.segmented)

                    amountField

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
                            ForEach(categories, id: \.self) { item in
                                let selected = item == category
                                Button {
                                    category = item
                                    UISelectionFeedbackGenerator().selectionChanged()
                                } label: {
                                    Text(item)
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

                    section("Описание") {
                        TextField(kind == .expense ? "Например, кофе" : "Например, аванс", text: $title)
                            .textInputAutocapitalization(.sentences)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 48)
                            .background(Theme.fill, in: .rect(cornerRadius: 16, style: .continuous))
                    }

                    DatePicker("Дата", selection: $date, displayedComponents: .date)
                        .font(.subheadline)
                        .environment(\.locale, Locale(identifier: "ru_RU"))

                    Button {
                        let preset: [String: JSONValue] = ["type": .string(kind.rawValue)]
                        dismiss()
                        AppShell.shared.open(["kind": .string("tx"), "preset": .object(preset)])
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
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle(kind == .expense ? "Новый расход" : "Новый доход")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
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
            }
            .onChange(of: kind) { _, next in
                if !categories.contains(category) { category = Self.defaultCategory(add, next) }
            }
            .onAppear { amountFocused = true }
        }
    }

    private var amountField: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            TextField("0", text: $amountText)
                .keyboardType(.decimalPad)
                .font(.system(size: 44, weight: .bold))
                .monospacedDigit()
                .focused($amountFocused)
                .fixedSize(horizontal: amountText.count > 0, vertical: false)
                .accessibilityLabel("Сумма в рублях")
            Text("₽")
                .font(.system(size: 44, weight: .bold))
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
            content()
        }
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

/// Раскладка «по строкам с переносом» — для чипов категорий.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
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
            let size = view.sizeThatFits(.unspecified)
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
