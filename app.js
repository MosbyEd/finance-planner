const BASE_STORAGE_KEY = "financePlannerData_v2";
let STORAGE_KEY = BASE_STORAGE_KEY;
const LEGACY_STORAGE_KEYS = ["financePlannerData_v1"];

const DEFAULT_CATEGORIES = {
  income: ["Зарплата", "Премия", "Фриланс"],
  fixedExpense: ["Аренда", "Ипотека/кредит", "Коммуналка", "Подписки"],
  flexibleExpense: ["Продукты", "Кафе/рестораны", "Транспорт", "Развлечения", "Одежда"],
};

function loadState() {
  try {
    const rawCurrent = localStorage.getItem(BASE_STORAGE_KEY);
    let raw = rawCurrent;
    let loadedFromLegacy = false;

    // Если данных в новом формате ещё нет, пробуем единоразово подтянуть legacy-версии.
    if (!raw) {
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw) {
          raw = legacyRaw;
          loadedFromLegacy = true;
          break;
        }
      }
    }

    if (!raw) {
      return {
        months: {},
        categories: { ...DEFAULT_CATEGORIES },
        fixedExpensePresets: [],
        incomePresets: [],
        ui: { monthPeriods: {}, todayBalanceOverrides: {}, monthRolloverHandled: {}, skippedRecurring: {} },
      };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        months: {},
        categories: { ...DEFAULT_CATEGORIES },
        fixedExpensePresets: [],
        incomePresets: [],
        ui: { monthPeriods: {}, todayBalanceOverrides: {}, monthRolloverHandled: {}, skippedRecurring: {} },
      };
    }

    const months = parsed.months && typeof parsed.months === "object" ? parsed.months : {};
    const categoriesFromStorage =
      parsed.categories && typeof parsed.categories === "object" ? parsed.categories : {};
    const presetsFromStorage = Array.isArray(parsed.fixedExpensePresets)
      ? parsed.fixedExpensePresets
      : [];
    const incomePresetsFromStorage = Array.isArray(parsed.incomePresets)
      ? parsed.incomePresets
      : [];

    const categories = {
      income: Array.isArray(categoriesFromStorage.income)
        ? [...new Set([...DEFAULT_CATEGORIES.income, ...categoriesFromStorage.income])]
        : [...DEFAULT_CATEGORIES.income],
      fixedExpense: Array.isArray(categoriesFromStorage.fixedExpense)
        ? [...new Set([...DEFAULT_CATEGORIES.fixedExpense, ...categoriesFromStorage.fixedExpense])]
        : [...DEFAULT_CATEGORIES.fixedExpense],
      flexibleExpense: Array.isArray(categoriesFromStorage.flexibleExpense)
        ? [...new Set([...DEFAULT_CATEGORIES.flexibleExpense, ...categoriesFromStorage.flexibleExpense])]
        : [...DEFAULT_CATEGORIES.flexibleExpense],
    };

    const fixedExpensePresets = presetsFromStorage
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: p.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: String(p.title || "").trim() || "Обязательный платёж",
        category: String(p.category || "").trim() || "Обязательный расход",
        amount: Number(p.amount) || 0,
        dayOfMonth: Math.min(Math.max(Number.parseInt(p.dayOfMonth || "1", 10) || 1, 1), 31),
        active: p.active !== false,
      }));

    const incomePresets = incomePresetsFromStorage
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: p.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: String(p.title || "").trim() || "Доход",
        category: String(p.category || "").trim() || "Зарплата",
        amount: Number(p.amount) || 0,
        dayOfMonth: Math.min(Math.max(Number.parseInt(p.dayOfMonth || "1", 10) || 1, 1), 31),
        active: p.active !== false,
      }));

    const uiRaw = parsed.ui && typeof parsed.ui === "object" ? parsed.ui : {};
    const monthPeriods =
      uiRaw.monthPeriods && typeof uiRaw.monthPeriods === "object" ? uiRaw.monthPeriods : {};
    const monthRolloverHandled =
      uiRaw.monthRolloverHandled && typeof uiRaw.monthRolloverHandled === "object"
        ? uiRaw.monthRolloverHandled
        : {};
    const skippedRecurring =
      uiRaw.skippedRecurring && typeof uiRaw.skippedRecurring === "object"
        ? uiRaw.skippedRecurring
        : {};
    const ui = {
      ...uiRaw,
      monthPeriods,
      monthRolloverHandled,
      skippedRecurring,
    };

    const state = { months, categories, fixedExpensePresets, incomePresets, ui };

    // Если мы загрузились из legacy-ключа (v1), один раз мигрируем данные в новый ключ.
    if (loadedFromLegacy) {
      saveState(state);
    }

    return state;
  } catch {
    return {
      months: {},
      categories: { ...DEFAULT_CATEGORIES },
      fixedExpensePresets: [],
      incomePresets: [],
      ui: { monthPeriods: {}, monthRolloverHandled: {}, skippedRecurring: {} },
    };
  }
}

function saveState(state) {
  localStorage.setItem(BASE_STORAGE_KEY, JSON.stringify(state));
}

function formatCurrency(value) {
  const n = Number.isFinite(value) ? value : 0;
  return n.toLocaleString("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function getMonthKeyFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDaysInMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

function ensureMonth(state, monthKey) {
  if (!state.months[monthKey]) {
    state.months[monthKey] = {
      transactions: [],
    };
  }
  return state.months[monthKey];
}

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

document.addEventListener("DOMContentLoaded", () => {
  // Унифицированный обработчик тапов: и click, и touchend, чтобы всё работало и в PWA, и в браузере
  function onTap(el, handler) {
    if (!el) return;
    let lastTouchTime = 0;
    const TOUCH_DELAY = 500;

    el.addEventListener(
      "touchend",
      (e) => {
        lastTouchTime = Date.now();
        e.preventDefault();
        handler(e);
      },
      { passive: false },
    );

    el.addEventListener("click", (e) => {
      if (Date.now() - lastTouchTime < TOUCH_DELAY) return;
      handler(e);
    });
  }

  const monthSelect = document.getElementById("monthSelect");
  const currentDateInput = document.getElementById("currentDate");
  const monthDaysEl = document.getElementById("monthDays");
  const currentDayNumberEl = document.getElementById("currentDayNumber");
  const resetMonthButton = document.getElementById("resetMonthButton");

  const totalIncomeEl = document.getElementById("totalIncome");
  const totalFixedExpensesEl = document.getElementById("totalFixedExpenses");
  const flexibleBudgetEl = document.getElementById("flexibleBudget");
  const autoSavingsEl = document.getElementById("autoSavings");
  const plannedDailyLimitEl = document.getElementById("plannedDailyLimit");
  const currentDailyLimitEl = document.getElementById("currentDailyLimit");
  const spentSoFarEl = document.getElementById("spentSoFar");
  const totalFlexibleExpensesEl = document.getElementById("totalFlexibleExpenses");
  const todayRecommendedEl = document.getElementById("todayRecommended");
  const todaySpentEl = document.getElementById("todaySpent");
  const monthSaldoEl = document.getElementById("monthSaldo");
  const saldoBadgeEl = document.getElementById("saldoBadge");
  const warningsListEl = document.getElementById("warningsList");

  const periodStartInput = document.getElementById("periodStartDate");
  const periodEndInput = document.getElementById("periodEndDate");
  const periodDaysEl = document.getElementById("periodDays");

  const transactionForm = document.getElementById("transactionForm");
  const transactionTypeInput = document.getElementById("transactionType");
  const transactionCategoryInput = document.getElementById("transactionCategory");
  const transactionTitleInput = document.getElementById("transactionTitle");
  const transactionAmountInput = document.getElementById("transactionAmount");
  const transactionDateInput = document.getElementById("transactionDate");
  const transactionNoteInput = document.getElementById("transactionNote");
  const fillSalaryExampleButton = document.getElementById("fillSalaryExample");

  const newCategoryNameInput = document.getElementById("newCategoryName");
  const addCategoryButton = document.getElementById("addCategoryButton");
  const transactionCategoryButtonsContainer = document.getElementById("transactionCategoryButtons");
  const expenseKindRow = document.getElementById("expenseKindRow");
  const expenseKindNormalButton = document.getElementById("expenseKindNormalButton");
  const expenseKindFixedButton = document.getElementById("expenseKindFixedButton");

  const typeExpenseButton = document.getElementById("typeExpenseButton");
  const typeIncomeButton = document.getElementById("typeIncomeButton");

  const transactionDateRow = document.getElementById("transactionDateRow");
  const transactionDateToggleButton = document.getElementById("transactionDateToggleButton");
  const transactionDateLabel = document.getElementById("transactionDateLabel");

  const transactionsFilterInput = document.getElementById("transactionsFilter");
  const transactionsDateFilterClearButton = document.getElementById("transactionsDateFilterClear");
  const historyPeriodTabDay = document.getElementById("historyPeriodTabDay");
  const historyPeriodTabMonth = document.getElementById("historyPeriodTabMonth");
  const historyPeriodTabRange = document.getElementById("historyPeriodTabRange");
  const historyFilterDayInput = document.getElementById("historyFilterDay");
  const historyFilterMonthInput = document.getElementById("historyFilterMonth");
  const historyFilterRangeStartInput = document.getElementById("historyFilterRangeStart");
  const historyFilterRangeEndInput = document.getElementById("historyFilterRangeEnd");
  const historyPeriodDayRow = document.getElementById("historyPeriodDayRow");
  const historyPeriodMonthRow = document.getElementById("historyPeriodMonthRow");
  const historyPeriodRangeRow = document.getElementById("historyPeriodRangeRow");
  const transactionsEmptyStateEl = document.getElementById("transactionsEmptyState");
  const transactionsListEl = document.getElementById("transactionsList");
  const transactionsHeaderSummaryEl = document.getElementById("transactionsHeaderSummary");
  const toggleTransactionsPanelButton = null;
  const transactionsPanelBody = document.getElementById("transactionsPanelBody");
  const headerAddOperationButton = document.getElementById("headerAddOperationButton");
  const toggleOperationsPanelButton = null;
  const operationsPanelBody = document.getElementById("operationsPanelBody");
  const togglePresetsPanelButton = null;
  const presetsPanelBody = document.getElementById("presetsPanelBody");
  const presetsHeaderSummaryEl = document.getElementById("presetsHeaderSummary");

  const tabDashboardButton = document.getElementById("tabDashboard");
  const tabHistoryButton = document.getElementById("tabHistory");
  const tabPresetsButton = document.getElementById("tabPresets");
  const tabAnalyticsButton = document.getElementById("tabAnalytics");
  const tabOperationsButton = document.getElementById("tabOperations");
  const summarySection = document.getElementById("summarySection");
  const saldoSection = document.getElementById("saldoSection");
  const presetsCard = document.getElementById("presetsCard");
  const transactionsCard = document.getElementById("transactionsCard");
  const addOperationCard = document.getElementById("addOperationCard");
  const analyticsSection = document.getElementById("analyticsSection");
  const analyticsTableBody = document.getElementById("analyticsTableBody");
  const plannerSection = document.getElementById("plannerSection");
  const plannerEmptyStateEl = document.getElementById("plannerEmptyState");
  const plannerListEl = document.getElementById("plannerList");
  const plannerTableBody = document.getElementById("plannerTableBody");

  const presetForm = document.getElementById("presetForm");
  const presetTitleInput = document.getElementById("presetTitle");
  const presetCategoryInput = document.getElementById("presetCategory");
  const presetAmountInput = document.getElementById("presetAmount");
  const presetDayInput = document.getElementById("presetDay");
  const presetListEl = document.getElementById("presetList");
  const presetEmptyStateEl = document.getElementById("presetEmptyState");
  const presetTypeInput = document.getElementById("presetType");
  const presetTypeExpenseButton = document.getElementById("presetTypeExpenseButton");
  const presetTypeIncomeButton = document.getElementById("presetTypeIncomeButton");
  const incomePresetForm = null;
  const incomePresetTitleInput = null;
  const incomePresetCategoryInput = null;
  const incomePresetAmountInput = null;
  const incomePresetDayInput = null;
  const incomePresetListEl = null;
  const incomePresetEmptyStateEl = null;
  const editMonthDetailsButton = document.getElementById("editMonthDetailsButton");
  const monthDetailsModal = document.getElementById("monthDetailsModal");
  const closeMonthDetailsButton = document.getElementById("closeMonthDetailsButton");
  const toggleMonthPanelButton = null;
  const monthPanelBody = null;
  const todaySummaryRow = document.getElementById("todaySummaryRow");
  const todayBalanceEl = document.getElementById("todayBalance");
  const todayBalanceEditRow = document.getElementById("todayBalanceEditRow");
  const todayBalanceEditButton = document.getElementById("todayBalanceEditButton");
  const todayBalanceInput = document.getElementById("todayBalanceInput");
  const todayBalanceCommentInput = document.getElementById("todayBalanceComment");
  const todayBalanceSaveButton = document.getElementById("todayBalanceSave");
  const todayBalanceCancelButton = document.getElementById("todayBalanceCancel");

  const editTransactionModal = document.getElementById("editTransactionModal");
  const closeEditTransactionButton = document.getElementById("closeEditTransactionButton");
  const editTransactionForm = document.getElementById("editTransactionForm");
  const editTypeExpenseButton = document.getElementById("editTypeExpenseButton");
  const editTypeIncomeButton = document.getElementById("editTypeIncomeButton");
  const editTransactionCategorySelect = document.getElementById("editTransactionCategory");
  const editTransactionTitleInput = document.getElementById("editTransactionTitle");
  const editTransactionAmountInput = document.getElementById("editTransactionAmount");
  const editTransactionDateInput = document.getElementById("editTransactionDate");
  const editTransactionNoteInput = document.getElementById("editTransactionNote");
  const cancelEditTransactionButton = document.getElementById("cancelEditTransactionButton");
  const editTransactionTypeInput = document.getElementById("editTransactionType");

  let state = loadState();
  let editingTransactionId = null;
  let editingPresetId = null;
  let lastBaseTodayRest = 0;

  function getCategoriesForType(type) {
    if (!state.categories) {
      state.categories = { ...DEFAULT_CATEGORIES };
    }
    if (!state.categories[type]) {
      state.categories[type] = [...DEFAULT_CATEGORIES[type]];
    }
    return state.categories[type];
  }

  function renderCategoryButtons(currentType, categories) {
    if (!transactionCategoryButtonsContainer) return;
    transactionCategoryButtonsContainer.innerHTML = "";
    const currentValue = transactionCategoryInput.value;
    for (const cat of categories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = cat;
      const isActive = currentValue === cat;
      btn.className =
        "px-3 py-1.5 rounded-full border text-[11px] transition-colors " +
        (isActive
          ? "bg-sky-500/20 border-sky-400 text-sky-100"
          : "bg-slate-900/60 border-slate-600 text-slate-200 hover:bg-slate-800");
      onTap(btn, () => {
        transactionCategoryInput.value = cat;
        renderCategoryButtons(currentType, categories);
      });
      transactionCategoryButtonsContainer.appendChild(btn);
    }
  }

  function renderCategoryOptions() {
    const type = transactionTypeInput.value || "income";
    const categories = getCategoriesForType(type);
    transactionCategoryInput.innerHTML = "";
    for (const cat of categories) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      transactionCategoryInput.appendChild(opt);
    }
    if (!transactionCategoryInput.value && categories.length > 0) {
      transactionCategoryInput.value = categories[0];
    }
    renderCategoryButtons(type, categories);
  }

  function applyTypeButtons() {
    if (!typeExpenseButton || !typeIncomeButton) return;
    const type = transactionTypeInput.value || "flexibleExpense";
    const setClass = (btn, isActive, activeColor) => {
      btn.className =
        "flex-1 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors " +
        (isActive
          ? activeColor
          : "border-slate-700/80 bg-slate-900/80 text-slate-100 hover:bg-slate-800");
    };
    setClass(
      typeExpenseButton,
      type === "flexibleExpense" || type === "fixedExpense",
      "border-rose-400/80 bg-rose-500/20 text-rose-100",
    );
    setClass(
      typeIncomeButton,
      type === "income",
      "border-emerald-400/80 bg-emerald-500/20 text-emerald-100",
    );

    if (expenseKindRow) {
      expenseKindRow.classList.toggle("hidden", type === "income");
      const isFixed = type === "fixedExpense";
      if (expenseKindNormalButton && expenseKindFixedButton) {
        expenseKindNormalButton.className =
          "px-2.5 py-1 rounded-full text-[11px] font-medium " +
          (isFixed
            ? "text-slate-300"
            : "bg-rose-500/20 text-rose-100 border border-rose-400/80");
        expenseKindFixedButton.className =
          "px-2.5 py-1 rounded-full text-[11px] font-medium " +
          (isFixed
            ? "bg-amber-500/20 text-amber-100 border border-amber-400/80"
            : "text-slate-300");
      }
    }
  }

  function renderPresetCategoryOptions() {
    if (!presetCategoryInput) return;
    const type =
      presetTypeInput && presetTypeInput.value === "income" ? "income" : "fixedExpense";
    const categories = getCategoriesForType(type);
    presetCategoryInput.innerHTML = "";
    for (const cat of categories) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      presetCategoryInput.appendChild(opt);
    }
  }

  function renderIncomePresetCategoryOptions() {
    // Категории доходов выбираются через общий селектор шаблонов;
    // отдельная отрисовка для формы доходов больше не используется.
    return;
  }

  function openEditTransactionModal(tx) {
    if (!tx || !editTransactionModal) return;
    editingTransactionId = tx.id;

    const type = tx.type || "flexibleExpense";
    const cats = getCategoriesForType(type);
    if (tx.category && !cats.includes(tx.category)) {
      cats.push(tx.category);
      state.categories[type] = cats;
      saveState(state);
    }

    if (editTypeExpenseButton && editTypeIncomeButton) {
      const isExpense = type === "flexibleExpense" || type === "fixedExpense";
      editTypeExpenseButton.className =
        "flex-1 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors " +
        (isExpense ? "border-rose-400/80 bg-rose-500/20 text-rose-100" : "border-slate-700/80 bg-slate-900/80 text-slate-100 hover:bg-slate-800");
      editTypeIncomeButton.className =
        "flex-1 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors " +
        (!isExpense ? "border-emerald-400/80 bg-emerald-500/20 text-emerald-100" : "border-slate-700/80 bg-slate-900/80 text-slate-100 hover:bg-slate-800");
    }

    renderEditModalCategoryOptions(type);
    if (editTransactionCategorySelect) editTransactionCategorySelect.value = tx.category || "";
    if (editTransactionTitleInput) editTransactionTitleInput.value = tx.title || "";
    if (editTransactionAmountInput) editTransactionAmountInput.value = tx.amount != null ? String(tx.amount) : "";
    if (editTransactionDateInput) editTransactionDateInput.value = tx.date || "";
    if (editTransactionNoteInput) editTransactionNoteInput.value = tx.note || "";
    if (editTransactionTypeInput) editTransactionTypeInput.value = type;

    editTransactionModal.classList.remove("hidden");
    editTransactionModal.classList.add("flex");
  }

  function closeEditTransactionModal() {
    if (!editTransactionModal) return;
    editTransactionModal.classList.add("hidden");
    editTransactionModal.classList.remove("flex");
    editingTransactionId = null;
  }

  function renderEditModalCategoryOptions(type) {
    if (!editTransactionCategorySelect) return;
    const categories = getCategoriesForType(type);
    editTransactionCategorySelect.innerHTML = "";
    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      editTransactionCategorySelect.appendChild(opt);
    });
  }

  function startEditTransaction(tx) {
    if (!tx) return;

    if (tx.type === "recurringExpense") {
      alert("Автоматические повторяемые расходы редактируются через шаблоны, а не напрямую.");
      return;
    }

    openEditTransactionModal(tx);
  }

  function handleEditTransactionSubmit(event) {
    event.preventDefault();
    if (!editingTransactionId) return;

    const typeVal = (editTransactionTypeInput && editTransactionTypeInput.value) || "flexibleExpense";
    const category = (editTransactionCategorySelect?.value || "").trim();
    const title = (editTransactionTitleInput?.value || "").trim();
    const amount = Number(editTransactionAmountInput?.value);
    const date = editTransactionDateInput?.value || "";
    const note = (editTransactionNoteInput?.value || "").trim();

    if (!["income", "fixedExpense", "flexibleExpense"].includes(typeVal)) {
      alert("Неверный тип операции.");
      return;
    }
    if (!category) {
      alert("Выберите категорию.");
      return;
    }
    if (!title) {
      alert("Введите название операции.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Введите корректную положительную сумму.");
      return;
    }
    const monthKeyFromDate = getMonthKeyFromDate(date);
    if (!monthKeyFromDate) {
      alert("Введите корректную дату.");
      return;
    }

    let foundMonthKey = null;
    let existing = null;
    for (const mk of Object.keys(state.months || {})) {
      const tx = (state.months[mk].transactions || []).find((t) => t.id === editingTransactionId);
      if (tx) {
        foundMonthKey = mk;
        existing = tx;
        break;
      }
    }
    if (!existing) {
      alert("Не удалось найти операцию для редактирования.");
      closeEditTransactionModal();
      render();
      return;
    }

    const targetMonthKey = monthKeyFromDate;
    if (targetMonthKey !== foundMonthKey) {
      state.months[foundMonthKey].transactions = state.months[foundMonthKey].transactions.filter(
        (t) => t.id !== editingTransactionId,
      );
      ensureMonth(state, targetMonthKey);
      state.months[targetMonthKey].transactions.push({
        id: existing.id,
        type: typeVal,
        category,
        title,
        amount,
        date,
        note,
      });
    } else {
      existing.type = typeVal;
      existing.category = category;
      existing.title = title;
      existing.amount = amount;
      existing.date = date;
      existing.note = note;
    }

    saveStateToServer();
    closeEditTransactionModal();
    render();
  }

  function applyPanelVisibilityFromState() {
    // Панель месяца теперь открывается во всплывающем окне, состояние не храним
  }

  function getHistoryPeriodMode() {
    const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    const mode = ui.historyPeriodMode || "month";
    return ["day", "month", "range"].includes(mode) ? mode : "month";
  }

  function setHistoryPeriodMode(mode) {
    state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    state.ui.historyPeriodMode = mode;
    saveState(state);
  }

  function setDefaultHistoryPeriodInputs(mode) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;

    if (mode === "day" && historyFilterDayInput && !historyFilterDayInput.value) {
      historyFilterDayInput.value = todayStr;
    }
    if (mode === "month" && historyFilterMonthInput) {
      if (!historyFilterMonthInput.value) {
        historyFilterMonthInput.value = monthSelect.value || `${y}-${m}`;
      }
    }
    // «Все»: период по умолчанию не заполняем — показываются все транзакции
  }

  function getTransactionsForHistory() {
    const mode = getHistoryPeriodMode();
    let list = [];

    if (mode === "day" && historyFilterDayInput && historyFilterDayInput.value) {
      const dayStr = historyFilterDayInput.value;
      const monthKey = getMonthKeyFromDate(dayStr);
      if (monthKey && state.months[monthKey]) {
        list = (state.months[monthKey].transactions || []).filter((tx) => tx.date === dayStr);
      }
    } else if (mode === "range") {
      const startStr = historyFilterRangeStartInput ? historyFilterRangeStartInput.value : "";
      const endStr = historyFilterRangeEndInput ? historyFilterRangeEndInput.value : "";
      if (!startStr && !endStr) {
        // Период не задан — показываем все транзакции из всех месяцев
        for (const monthKey of Object.keys(state.months || {})) {
          const txs = state.months[monthKey]?.transactions || [];
          list.push(...txs);
        }
      } else if (startStr && endStr) {
        const start = new Date(startStr);
        const end = new Date(endStr);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
          const monthKeys = new Set();
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const key = getMonthKeyFromDate(d.toISOString().slice(0, 10));
            if (key) monthKeys.add(key);
          }
          for (const monthKey of monthKeys) {
            const txs = state.months[monthKey]?.transactions || [];
            for (const tx of txs) {
              const txDate = tx.date || "";
              if (txDate >= startStr && txDate <= endStr) list.push(tx);
            }
          }
        }
      }
    } else if (mode === "month" && historyFilterMonthInput && historyFilterMonthInput.value) {
      const monthKey = historyFilterMonthInput.value;
      if (state.months[monthKey]) {
        list = state.months[monthKey].transactions || [];
      }
    }

    // В историю не попадают ещё не сработавшие плановые операции из шаблонов
    const currentDateStr = currentDateInput ? currentDateInput.value : "";
    return list.filter((tx) => {
      if (!tx || !tx.date) return true;
      if (tx.date > currentDateStr && tx.presetId) return false;
      return true;
    });
  }

  function applyHistoryPeriodTabUI() {
    const mode = getHistoryPeriodMode();
    const activeClass = "bg-slate-700/80 text-slate-100 border border-slate-500/60";
    const inactiveClass = "text-slate-400 hover:text-slate-100 border border-transparent";

    [historyPeriodTabDay, historyPeriodTabMonth, historyPeriodTabRange].forEach((btn) => {
      if (!btn) return;
      const isActive = btn.getAttribute("data-mode") === mode;
      btn.className = `history-period-tab px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${isActive ? activeClass : inactiveClass}`;
    });

    if (historyPeriodDayRow) historyPeriodDayRow.classList.toggle("hidden", mode !== "day");
    if (historyPeriodMonthRow) historyPeriodMonthRow.classList.toggle("hidden", mode !== "month");
    if (historyPeriodRangeRow) historyPeriodRangeRow.classList.toggle("hidden", mode !== "range");
  }

  function setActiveTab(tab, saveToState = true) {
    const allowed = ["operations", "dashboard", "history", "presets", "analytics"];
    if (!allowed.includes(tab)) tab = "dashboard";

    if (saveToState) {
      state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      state.ui.currentTab = tab;
      saveState(state);
    }

    const isOperations = tab === "operations";
    const isDashboard = tab === "dashboard";
    const isHistory = tab === "history";
    const isPresets = tab === "presets";
    const isAnalytics = tab === "analytics";

    if (tabOperationsButton) {
      tabOperationsButton.classList.toggle("bg-slate-800/80", isOperations);
      tabOperationsButton.classList.toggle("border-slate-500/60", isOperations);
      tabOperationsButton.classList.toggle("text-slate-50", isOperations);
      tabOperationsButton.classList.toggle("border-transparent", !isOperations);
      tabOperationsButton.classList.toggle("text-slate-400", !isOperations);
    }

    if (tabDashboardButton) {
      tabDashboardButton.classList.toggle("bg-slate-800/80", isDashboard);
      tabDashboardButton.classList.toggle("border-slate-500/60", isDashboard);
      tabDashboardButton.classList.toggle("text-slate-50", isDashboard);
      tabDashboardButton.classList.toggle("border-transparent", !isDashboard);
      tabDashboardButton.classList.toggle("text-slate-400", !isDashboard);
    }
    if (tabHistoryButton) {
      tabHistoryButton.classList.toggle("bg-slate-800/80", isHistory);
      tabHistoryButton.classList.toggle("border-slate-500/60", isHistory);
      tabHistoryButton.classList.toggle("text-slate-50", isHistory);
      tabHistoryButton.classList.toggle("border-transparent", !isHistory);
      tabHistoryButton.classList.toggle("text-slate-400", !isHistory);
    }
    if (tabPresetsButton) {
      tabPresetsButton.classList.toggle("bg-slate-800/80", isPresets);
      tabPresetsButton.classList.toggle("border-slate-500/60", isPresets);
      tabPresetsButton.classList.toggle("text-slate-50", isPresets);
      tabPresetsButton.classList.toggle("border-transparent", !isPresets);
      tabPresetsButton.classList.toggle("text-slate-400", !isPresets);
    }
    if (tabAnalyticsButton) {
      tabAnalyticsButton.classList.toggle("bg-slate-800/80", isAnalytics);
      tabAnalyticsButton.classList.toggle("border-slate-500/60", isAnalytics);
      tabAnalyticsButton.classList.toggle("text-slate-50", isAnalytics);
      tabAnalyticsButton.classList.toggle("border-transparent", !isAnalytics);
      tabAnalyticsButton.classList.toggle("text-slate-400", !isAnalytics);
    }

    if (summarySection) {
      summarySection.classList.toggle("hidden", !isDashboard);
    }
    if (saldoSection) {
      saldoSection.classList.toggle("hidden", !isDashboard);
    }
    if (plannerSection) {
      plannerSection.classList.toggle("hidden", !isDashboard);
    }

    if (transactionsCard) {
      // Список операций выбранного месяца показываем только в табе «История»
      transactionsCard.classList.toggle("hidden", !isHistory);
    }
    if (presetsCard) {
      presetsCard.classList.toggle("hidden", !isPresets);
    }
    if (addOperationCard) {
      addOperationCard.classList.toggle("hidden", !isOperations);
    }
    if (analyticsSection) {
      analyticsSection.classList.toggle("hidden", !isAnalytics);
    }
    if (todaySummaryRow) {
      todaySummaryRow.classList.remove("hidden");
    }
  }

  function focusTransactionForm() {
    if (!transactionForm) return;
    transactionForm.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      if (transactionTitleInput) {
        transactionTitleInput.focus();
      } else if (transactionAmountInput) {
        transactionAmountInput.focus();
      }
    }, 200);
  }

  function addCategoryForCurrentType() {
    const rawName = newCategoryNameInput.value.trim();
    if (!rawName) return;
    const type = transactionTypeInput.value || "income";
    const categories = getCategoriesForType(type);
    if (!categories.includes(rawName)) {
      categories.push(rawName);
      state.categories[type] = categories;
      saveState(state);
      renderCategoryOptions();
      transactionCategoryInput.value = rawName;
      if (type === "fixedExpense") {
        renderPresetCategoryOptions();
      }
    }
    newCategoryNameInput.value = "";
  }

  function initDefaultDates() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const monthKeyFromToday = `${year}-${month}`;
    const todayStr = `${year}-${month}-${day}`;

    monthSelect.value = monthKeyFromToday;
    currentDateInput.value = todayStr;
    transactionDateInput.value = todayStr;
    syncPeriodInputsForMonth(monthKeyFromToday);

    if (transactionDateLabel) {
      transactionDateLabel.textContent = `Дата операции: ${todayStr}`;
    }
  }

  function applyAuthUi() {
    // авторизация отключена в локальном режиме
  }

  function applyInitialTabFromState() {
    const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    const currentTab = ui.currentTab || "operations";
    setActiveTab(currentTab, false);
  }

  function syncPeriodInputsForMonth(monthKey) {
    if (!periodStartInput || !periodEndInput) return;
    if (!monthKey) return;

    const [yearStr, monthStr] = monthKey.split("-");
    const year = Number.parseInt(yearStr, 10);
    const monthIndexZeroBased = Number.parseInt(monthStr, 10) - 1;
    const daysInMonth = getDaysInMonth(year, monthIndexZeroBased);
    const firstDayStr = `${yearStr}-${monthStr}-01`;
    const lastDayStr = `${yearStr}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

    const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    if (!ui.monthPeriods || typeof ui.monthPeriods !== "object") {
      ui.monthPeriods = {};
    }
    const existing = ui.monthPeriods[monthKey];

    const periodStartToUse = existing?.start || firstDayStr;
    const periodEndToUse = existing?.end || lastDayStr;

    periodStartInput.value = periodStartToUse;
    periodEndInput.value = periodEndToUse;

    ui.monthPeriods[monthKey] = { start: periodStartToUse, end: periodEndToUse };
    state.ui = ui;
    saveState(state);

    updatePeriodInfo();
  }

  function loadStateFromServer() {
    state = loadState();
    renderCategoryOptions();
    renderPresetCategoryOptions();
    ensurePresetsForMonth(monthSelect.value);
    ensureIncomePresetsForMonth(monthSelect.value);
    applyPanelVisibilityFromState();
    applyInitialTabFromState();
    render();
  }

  function saveStateToServer() {
    saveState(state);
  }

  function updatePeriodInfo() {
    if (!periodStartInput || !periodEndInput || !periodDaysEl) return;
    const monthKey = monthSelect.value;
    const startStr = periodStartInput.value;
    const endStr = periodEndInput.value;
    if (!startStr || !endStr) {
      periodDaysEl.textContent = "—";
      return;
    }
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      periodDaysEl.textContent = "—";
      return;
    }
    const diffMs = end.getTime() - start.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
    periodDaysEl.textContent = String(days);

    if (monthKey) {
      state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      if (!state.ui.monthPeriods || typeof state.ui.monthPeriods !== "object") {
        state.ui.monthPeriods = {};
      }
      state.ui.monthPeriods[monthKey] = { start: startStr, end: endStr };
    }
    saveStateToServer();

    render();
  }

  function computeMetricsForMonth(monthKey, currentDateStr, periodStartStr, periodEndStr) {
    const monthData = state.months[monthKey];
    if (!monthData) {
      return {
        totalIncome: 0,
        totalFixed: 0,
        autoSavings: 0,
        flexibleBudget: 0,
        plannedDailyLimit: 0,
        currentDailyLimit: 0,
        spentSoFar: 0,
        flexibleExpensesTotal: 0,
        saldo: 0,
        daysInMonth: 0,
        currentDayNumber: 0,
        warnings: ["Добавьте хотя бы один доход и обязательные расходы, чтобы увидеть лимиты."],
      };
    }

    const transactions = monthData.transactions || [];
    const warnings = [];

    let totalIncome = 0;
    let totalSalaryIncome = 0;
    let totalFixed = 0;
    let flexibleExpensesTotal = 0;
    let flexibleExpensesOnly = 0;
    let spentSoFar = 0;
    let spentToday = 0;
    let savingTransfersTotal = 0;
    let flexibleSpentSoFar = 0;
    let flexibleSpentToday = 0;
    let totalIncomeToDate = 0;
    let totalFixedToDate = 0;

    const d = currentDateStr ? new Date(currentDateStr) : null;
    let year = null;
    let monthIndexZeroBased = null;

    if (d && !Number.isNaN(d.getTime())) {
      year = d.getFullYear();
      monthIndexZeroBased = d.getMonth();
    } else {
      const [y, m] = monthKey.split("-");
      year = Number.parseInt(y, 10);
      monthIndexZeroBased = Number.parseInt(m, 10) - 1;
    }

    const daysInMonth = getDaysInMonth(year, monthIndexZeroBased);
    const currentDayNumber = d && !Number.isNaN(d.getTime()) ? d.getDate() : 1;

    for (const tx of transactions) {
      if (tx.type === "balanceAdjustment") {
        // Корректировки не влияют на расчёт бюджета и трат
        continue;
      }
      const amount = Number(tx.amount) || 0;
      const txDate = tx.date || "";
      const inPeriod =
        (!periodStartStr || (txDate && txDate >= periodStartStr)) &&
        (!periodEndStr || (txDate && txDate <= periodEndStr));
      if (!inPeriod) continue;

      if (tx.type === "income") {
        totalIncome += amount;
        if (txDate && currentDateStr && txDate <= currentDateStr) {
          totalIncomeToDate += amount;
        }
        if (tx.category === "Зарплата") {
          totalSalaryIncome += amount;
        }
      } else if (tx.type === "fixedExpense" || tx.type === "recurringExpense") {
        totalFixed += amount;
        if (txDate && currentDateStr && txDate <= currentDateStr) {
          totalFixedToDate += amount;
        }
      } else if (tx.type === "flexibleExpense") {
        flexibleExpensesTotal += amount;
        flexibleExpensesOnly += amount;
        if (tx.date && currentDateStr && tx.date <= currentDateStr) {
          spentSoFar += amount;
          flexibleSpentSoFar += amount;
        }
        if (tx.date && currentDateStr && tx.date === currentDateStr) {
          spentToday += amount;
          flexibleSpentToday += amount;
        }
      } else if (tx.type === "savingTransfer") {
        // Переводы в накопления учитываем как траты для сальдо и остатка,
        // но не как "обычные расходы" месяца (flexibleExpensesOnly).
        flexibleExpensesTotal += amount;
        savingTransfersTotal += amount;
        if (tx.date && currentDateStr && tx.date <= currentDateStr) {
          spentSoFar += amount;
        }
        if (tx.date && currentDateStr && tx.date === currentDateStr) {
          spentToday += amount;
        }
      }
    }

    const autoSavings = savingTransfersTotal;
    const flexibleBudget = totalIncome - totalFixed;
    let plannedDailyLimit = 0;
    if (daysInMonth > 0) {
      plannedDailyLimit = flexibleBudget / daysInMonth;
    }

    const remainingFlexibleBudget = flexibleBudget - spentSoFar;
    const remainingDays = Math.max(daysInMonth - currentDayNumber + 1, 0);
    let currentDailyLimit = 0;
    if (remainingDays > 0) {
      currentDailyLimit = remainingFlexibleBudget / remainingDays;
    }

    const saldo = flexibleBudget - flexibleExpensesTotal;

    if (totalIncome <= 0) {
      warnings.push("Нет доходов за месяц — добавьте хотя бы один источник дохода.");
    }
    if (totalIncome > 0 && totalFixed <= 0) {
      warnings.push(
        "Нет крупных или повторяемых расходов — добавьте аренду, кредиты и т.п. для реалистичного плана.",
      );
    }
    if (flexibleBudget < 0) {
      warnings.push(
        "Обязательные расходы превышают доходы. Пересмотрите план или постарайтесь сократить фиксированные траты.",
      );
    }
    if (remainingFlexibleBudget < 0) {
      warnings.push(
        "Фактические обычные расходы превысили гибкий бюджет — вы выходите за рамки месячного плана.",
      );
    }

    return {
      totalIncome,
      totalFixed,
      autoSavings,
      flexibleBudget,
      plannedDailyLimit,
      currentDailyLimit,
      spentSoFar,
      spentToday,
      flexibleExpensesTotal,
      saldo,
      totalIncomeToDate,
      totalFixedToDate,
      flexibleSpentSoFar,
      flexibleExpensesOnly,
      flexibleSpentToday,
      daysInMonth,
      currentDayNumber,
      warnings,
    };
  }

  function render() {
    const monthKey = monthSelect.value;
    const currentDateStr = currentDateInput.value;
    const periodStartStr = periodStartInput ? periodStartInput.value : null;
    const periodEndStr = periodEndInput ? periodEndInput.value : null;

    if (!monthKey) {
      totalIncomeEl.textContent = formatCurrency(0);
      totalFixedExpensesEl.textContent = formatCurrency(0);
      flexibleBudgetEl.textContent = formatCurrency(0);
      plannedDailyLimitEl.textContent = formatCurrency(0);
      if (currentDailyLimitEl) {
        currentDailyLimitEl.textContent = formatCurrency(0);
      }
      if (spentSoFarEl) {
        spentSoFarEl.textContent = formatCurrency(0);
      }
      if (todayRecommendedEl) {
        todayRecommendedEl.textContent = formatCurrency(0);
      }
      if (todaySpentEl) {
        todaySpentEl.textContent = formatCurrency(0);
      }
      if (todayBalanceEl) {
        todayBalanceEl.textContent = formatCurrency(0);
      }
      lastBaseTodayRest = 0;
      monthSaldoEl.textContent = formatCurrency(0);
      monthDaysEl.textContent = "—";
      currentDayNumberEl.textContent = "—";
      warningsListEl.innerHTML =
        '<li class="text-[11px] text-slate-400">Выберите месяц, чтобы начать планирование.</li>';
      return;
    }

    ensurePresetsForMonth(monthKey);
    ensureIncomePresetsForMonth(monthKey);
    const metrics = computeMetricsForMonth(monthKey, currentDateStr, periodStartStr, periodEndStr);

    totalIncomeEl.textContent = formatCurrency(metrics.totalIncome);
    totalFixedExpensesEl.textContent = formatCurrency(metrics.totalFixed);
    autoSavingsEl.textContent = formatCurrency(metrics.autoSavings);
    flexibleBudgetEl.textContent = formatCurrency(metrics.flexibleBudget);
    plannedDailyLimitEl.textContent = formatCurrency(Math.max(metrics.plannedDailyLimit, 0));
    if (currentDailyLimitEl) {
      currentDailyLimitEl.textContent = formatCurrency(Math.max(metrics.currentDailyLimit, 0));
    }
    if (spentSoFarEl) {
      spentSoFarEl.textContent = formatCurrency(metrics.spentSoFar);
    }
    if (todayRecommendedEl) {
      todayRecommendedEl.textContent = formatCurrency(Math.max(metrics.currentDailyLimit, 0));
    }
    if (todaySpentEl) {
      todaySpentEl.textContent = formatCurrency(metrics.spentToday || 0);
    }
    if (totalFlexibleExpensesEl) {
      // Показываем все обычные расходы за месяц (с 1-го числа), без переводов в накопления
      totalFlexibleExpensesEl.textContent = formatCurrency(metrics.flexibleExpensesOnly || 0);
    }
    monthSaldoEl.textContent = formatCurrency(metrics.saldo);

    const incomeToDate = metrics.totalIncomeToDate || 0;
    const fixedToDate = metrics.totalFixedToDate || 0;
    let baseTodayRest = 0;
    if (currentDateStr) {
    for (const mk of Object.keys(state.months || {})) {
      const m = state.months[mk];
      if (!m || !Array.isArray(m.transactions)) continue;
      for (const tx of m.transactions) {
        if (!tx) continue;
        const txDate = tx.date || "";
        if (!txDate || txDate > currentDateStr) continue;
        const amount = Number(tx.amount) || 0;
        if (!Number.isFinite(amount) || amount === 0) continue;
        if (tx.type === "income") {
          baseTodayRest += amount;
        } else if (tx.type === "balanceAdjustment") {
          // Корректировка остатка: delta с любым знаком, просто добавляем
          baseTodayRest += amount;
        } else if (
          tx.type === "fixedExpense" ||
          tx.type === "recurringExpense" ||
          tx.type === "flexibleExpense" ||
          tx.type === "savingTransfer"
        ) {
          baseTodayRest -= amount;
        }
      }
    }
    }
    baseTodayRest = Math.max(baseTodayRest, 0);
    lastBaseTodayRest = baseTodayRest;
    const todayRestDisplay = baseTodayRest;
    if (todayBalanceEl) {
      todayBalanceEl.textContent = formatCurrency(todayRestDisplay);
    }

    monthDaysEl.textContent = metrics.daysInMonth || "—";
    currentDayNumberEl.textContent = metrics.currentDayNumber || "—";

    warningsListEl.innerHTML = "";
    if (metrics.warnings.length === 0) {
      const li = document.createElement("li");
      li.textContent = "План выглядит сбалансированным относительно текущих данных.";
      li.className = "text-[11px] text-emerald-200";
      warningsListEl.appendChild(li);
    } else {
      for (const w of metrics.warnings) {
        const li = document.createElement("li");
        li.textContent = w;
        li.className = "text-[11px] text-slate-400";
        warningsListEl.appendChild(li);
      }
    }

    if (metrics.saldo > 0) {
      saldoBadgeEl.textContent = "Вы в плюсе по месяцу и формируете сбережения.";
      saldoBadgeEl.className =
        "px-3 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-100 max-w-xs";
    } else if (metrics.saldo < 0) {
      saldoBadgeEl.textContent = "Сальдо отрицательное: обычные расходы превышают гибкий бюджет.";
      saldoBadgeEl.className =
        "px-3 py-2 rounded-xl border border-rose-500/60 bg-rose-500/10 text-xs text-rose-100 max-w-xs";
    } else {
      saldoBadgeEl.textContent = "Сальдо около нуля — вы тратите ровно гибкий бюджет.";
      saldoBadgeEl.className =
        "px-3 py-2 rounded-xl border border-sky-500/40 bg-sky-500/10 text-xs text-sky-100 max-w-xs";
    }

    renderTransactionsList();
    renderPresetList();
    renderPlanner();

    saveStateToServer();
  }

  function ensurePresetsForMonth(monthKey) {
    if (!monthKey) return;
    const presets = state.fixedExpensePresets || [];
    if (presets.length === 0) return;

    const monthData = ensureMonth(state, monthKey);
    const [yearStr, monthStr] = monthKey.split("-");
    const year = Number.parseInt(yearStr, 10);
    const monthIndexZeroBased = Number.parseInt(monthStr, 10) - 1;
    const daysInMonth = getDaysInMonth(year, monthIndexZeroBased);

    let changed = false;

    if (Array.isArray(monthData.transactions)) {
      for (const tx of monthData.transactions) {
        if (tx.type === "fixedExpense" && tx.presetId) {
          tx.type = "recurringExpense";
          changed = true;
        }
      }
    }

    for (const preset of presets) {
      if (!preset.active) continue;
      const day = Math.min(Math.max(Number.parseInt(preset.dayOfMonth, 10) || 1, 1), daysInMonth);
      const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, "0")}`;

      const exists = monthData.transactions.some(
        (tx) => tx.type === "recurringExpense" && tx.presetId === preset.id && tx.date === dateStr,
      );
      if (exists) continue;

      monthData.transactions.push({
        id: generateId(),
        type: "recurringExpense",
        category: preset.category || "Повторяемый расход",
        title: preset.title || "Повторяемый расход",
        amount: Number(preset.amount) || 0,
        date: dateStr,
        note: "Авто: повторяемый расход",
        presetId: preset.id,
      });
      changed = true;
    }

    if (changed) {
      saveState(state);
    }
  }

  function ensureIncomePresetsForMonth(monthKey) {
    if (!monthKey) return;
    const presets = state.incomePresets || [];
    if (presets.length === 0) return;

    const monthData = ensureMonth(state, monthKey);
    const [yearStr, monthStr] = monthKey.split("-");
    const year = Number.parseInt(yearStr, 10);
    const monthIndexZeroBased = Number.parseInt(monthStr, 10) - 1;
    const daysInMonth = getDaysInMonth(year, monthIndexZeroBased);

    let changed = false;

    for (const preset of presets) {
      if (!preset.active) continue;
      const day = Math.min(Math.max(Number.parseInt(preset.dayOfMonth, 10) || 1, 1), daysInMonth);
      const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, "0")}`;

      const exists = monthData.transactions.some(
        (tx) => tx.type === "income" && tx.presetId === preset.id && tx.date === dateStr,
      );
      if (exists) continue;

      monthData.transactions.push({
        id: generateId(),
        type: "income",
        category: preset.category || "Доход",
        title: preset.title || "Доход",
        amount: Number(preset.amount) || 0,
        date: dateStr,
        note: "Авто: планируемый доход",
        presetId: preset.id,
      });
      changed = true;
    }

    if (changed) {
      saveState(state);
    }
  }

  function renderTransactionsList() {
    const typeFilter = transactionsFilterInput.value;
    const transactions = getTransactionsForHistory();

    let filtered = transactions;
    if (typeFilter !== "all") {
      filtered = filtered.filter((tx) => tx.type === typeFilter);
    }

    if (transactionsHeaderSummaryEl) {
      const count = filtered.length;
      if (count === 0) {
        transactionsHeaderSummaryEl.textContent = "Нет операций";
      } else if (count === 1) {
        transactionsHeaderSummaryEl.textContent = "1 операция";
      } else if (count >= 2 && count <= 4) {
        transactionsHeaderSummaryEl.textContent = `${count} операции`;
      } else {
        transactionsHeaderSummaryEl.textContent = `${count} операций`;
      }
    }

    if (filtered.length === 0) {
      transactionsEmptyStateEl.classList.remove("hidden");
      transactionsListEl.classList.add("hidden");
      transactionsListEl.innerHTML = "";
      return;
    }

    transactionsEmptyStateEl.classList.add("hidden");
    transactionsListEl.classList.remove("hidden");
    transactionsListEl.innerHTML = "";

    const sorted = [...filtered].sort((a, b) => {
      // Сначала по дате: самые поздние выше
      if (a.date !== b.date) {
        return a.date > b.date ? -1 : 1;
      }
      // При равной дате — более поздно добавленные выше (по id/времени)
      return (b.id || "").localeCompare(a.id || "");
    });

    for (const tx of sorted) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-2 px-1.5 py-1.5";

      const left = document.createElement("div");
      left.className = "flex flex-col";

      const titleRow = document.createElement("div");
      titleRow.className = "flex items-center gap-1.5";

      const title = document.createElement("span");
      title.textContent = tx.title || "(без названия)";
      title.className = "text-[11px] text-slate-100";
      titleRow.appendChild(title);

      const typeBadge = document.createElement("span");
      typeBadge.className = "text-[9px] px-1.5 py-0.5 rounded-full border";
      if (tx.type === "income") {
        typeBadge.textContent = "Доход";
        typeBadge.className += " border-emerald-400/50 bg-emerald-500/10 text-emerald-200";
      } else if (tx.type === "fixedExpense") {
        typeBadge.textContent = "Крупная покупка";
        typeBadge.className += " border-amber-400/50 bg-amber-500/10 text-amber-200";
      } else if (tx.type === "recurringExpense") {
        typeBadge.textContent = "Повторяемый";
        typeBadge.className += " border-amber-300/50 bg-amber-400/10 text-amber-100";
      } else if (tx.type === "balanceAdjustment") {
        typeBadge.textContent = "Корректировка";
        typeBadge.className += " border-fuchsia-400/60 bg-fuchsia-500/10 text-fuchsia-200";
      } else if (tx.type === "savingTransfer") {
        typeBadge.textContent = "В накопления";
        typeBadge.className += " border-emerald-400/60 bg-emerald-500/10 text-emerald-200";
      } else {
        typeBadge.textContent = "Обычный";
        typeBadge.className += " border-sky-400/50 bg-sky-500/10 text-sky-200";
      }
      titleRow.appendChild(typeBadge);

      left.appendChild(titleRow);

      const sub = document.createElement("span");
      sub.className = "text-[10px] text-slate-500";
      const dateStr = tx.date || "";
      const categoryStr = tx.category ? ` · ${tx.category}` : "";
      if (tx.note) {
        sub.textContent = `${dateStr}${categoryStr} · ${tx.note}`;
      } else {
        sub.textContent = `${dateStr}${categoryStr}` || "дата не указана";
      }
      left.appendChild(sub);

      const right = document.createElement("div");
      right.className = "flex items-center gap-2";

      const amountSpan = document.createElement("span");
      const amount = Number(tx.amount) || 0;
      amountSpan.textContent = formatCurrency(amount);
      if (tx.type === "income") {
        amountSpan.className = "text-[11px] font-semibold text-emerald-200";
      } else if (tx.type === "balanceAdjustment") {
        amountSpan.className = "text-[11px] font-semibold text-fuchsia-200";
      } else if (tx.type === "savingTransfer") {
        amountSpan.className = "text-[11px] font-semibold text-emerald-200";
      } else {
        amountSpan.className = "text-[11px] font-semibold text-rose-200";
      }
      right.appendChild(amountSpan);

      const canEdit =
        tx.type === "income" || tx.type === "fixedExpense" || tx.type === "flexibleExpense";
      if (canEdit) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✎";
        editBtn.title = "Редактировать операцию";
        editBtn.className =
          "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-sky-600/80 hover:border-sky-500 hover:text-white transition-colors";
        onTap(editBtn, () => startEditTransaction(tx));
        right.appendChild(editBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Удалить операцию";
      deleteBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-rose-600/80 hover:border-rose-500 hover:text-white transition-colors";
      onTap(deleteBtn, () => deleteTransaction(tx.id));
      right.appendChild(deleteBtn);

      row.appendChild(left);
      row.appendChild(right);

      transactionsListEl.appendChild(row);
    }

    renderAnalyticsTable();
  }

  function renderAnalyticsTable() {
    if (!analyticsTableBody) return;

    const monthKey = monthSelect.value;
    const monthData = state.months[monthKey];
    const transactions = monthData?.transactions || [];

    const periodStartStr = periodStartInput ? periodStartInput.value : null;
    const periodEndStr = periodEndInput ? periodEndInput.value : null;

    const expenses = transactions.filter((tx) => {
      const isExpense =
        tx.type === "fixedExpense" ||
        tx.type === "flexibleExpense" ||
        tx.type === "recurringExpense";
      if (!isExpense) return false;
      const txDate = tx.date || "";
      const inPeriod =
        (!periodStartStr || (txDate && txDate >= periodStartStr)) &&
        (!periodEndStr || (txDate && txDate <= periodEndStr));
      return inPeriod;
    });

    const totalsByCategory = new Map();
    let totalExpenses = 0;
    for (const tx of expenses) {
      const amount = Number(tx.amount) || 0;
      if (amount <= 0) continue;
      totalExpenses += amount;
      const key = tx.category || "Без категории";
      totalsByCategory.set(key, (totalsByCategory.get(key) || 0) + amount);
    }

    analyticsTableBody.innerHTML = "";

    if (totalExpenses <= 0 || totalsByCategory.size === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 3;
      td.className = "py-2 text-slate-500";
      td.textContent = "Нет расходов в выбранном периоде.";
      tr.appendChild(td);
      analyticsTableBody.appendChild(tr);
      return;
    }

    const entries = Array.from(totalsByCategory.entries()).sort((a, b) => b[1] - a[1]);

    for (const [category, sum] of entries) {
      const percent = (sum / totalExpenses) * 100;
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-800/70";

      const tdCat = document.createElement("td");
      tdCat.className = "py-1.5 pr-4";
      tdCat.textContent = category;

      const tdSum = document.createElement("td");
      tdSum.className = "py-1.5 pr-4 text-right";
      tdSum.textContent = formatCurrency(sum);

      const tdPct = document.createElement("td");
      tdPct.className = "py-1.5 text-right text-slate-300";
      tdPct.textContent = `${percent.toFixed(1)}%`;

      tr.appendChild(tdCat);
      tr.appendChild(tdSum);
      tr.appendChild(tdPct);

      analyticsTableBody.appendChild(tr);
    }
  }

  function renderPlanner() {
    if (!plannerSection || !plannerEmptyStateEl || !plannerListEl || !plannerTableBody) return;

    const monthKey = monthSelect.value;
    const currentDateStr = currentDateInput.value;
    if (!monthKey || !currentDateStr) {
      plannerEmptyStateEl.classList.remove("hidden");
      plannerListEl.classList.add("hidden");
      plannerTableBody.innerHTML = "";
      return;
    }

    const monthData = state.months[monthKey];
    const transactions = monthData?.transactions || [];
    const periodStartStr = periodStartInput ? periodStartInput.value : null;
    const periodEndStr = periodEndInput ? periodEndInput.value : null;

    const planned = transactions.filter((tx) => {
      const txDate = tx.date || "";
      if (!txDate) return false;
      if (txDate <= currentDateStr) return false;
      if (periodStartStr && txDate < periodStartStr) return false;
      if (periodEndStr && txDate > periodEndStr) return false;
      if (tx.type === "balanceAdjustment") return false;
      return true;
    });

    if (planned.length === 0) {
      plannerEmptyStateEl.classList.remove("hidden");
      plannerListEl.classList.add("hidden");
      plannerTableBody.innerHTML = "";
      return;
    }

    plannerEmptyStateEl.classList.add("hidden");
    plannerListEl.classList.remove("hidden");
    plannerTableBody.innerHTML = "";

    const sorted = [...planned].sort((a, b) => {
      if (a.date === b.date) {
        return (a.id || "").localeCompare(b.id || "");
      }
      return a.date < b.date ? -1 : 1;
    });

    for (const tx of sorted) {
      const tr = document.createElement("tr");
      tr.className = "border-t border-slate-800/70";

      const tdDate = document.createElement("td");
      tdDate.className = "py-1.5 pr-3 align-top text-slate-400";
      tdDate.textContent = tx.date || "";

      const tdDesc = document.createElement("td");
      tdDesc.className = "py-1.5 pr-3 align-top";
      const title = document.createElement("div");
      title.className = "text-slate-100";
      title.textContent = tx.title || "(без названия)";
      const meta = document.createElement("div");
      meta.className = "text-[10px] text-slate-500";
      const parts = [];
      if (tx.type === "income") parts.push("Доход");
      else if (tx.type === "fixedExpense") parts.push("Крупный расход");
      else if (tx.type === "recurringExpense") parts.push("Повторяемый расход");
      else if (tx.type === "flexibleExpense") parts.push("Обычный расход");
      else if (tx.type === "savingTransfer") parts.push("Перевод в накопления");
      if (tx.category) parts.push(tx.category);
      if (tx.note) parts.push(tx.note);
      meta.textContent = parts.join(" · ");
      tdDesc.appendChild(title);
      tdDesc.appendChild(meta);

      const tdAmount = document.createElement("td");
      tdAmount.className = "py-1.5 text-right align-top";
      const amount = Number(tx.amount) || 0;
      tdAmount.textContent = formatCurrency(amount);

      tr.appendChild(tdDate);
      tr.appendChild(tdDesc);
      tr.appendChild(tdAmount);
      plannerTableBody.appendChild(tr);
    }
  }

  function deleteTransaction(id) {
    for (const monthKey of Object.keys(state.months || {})) {
      const monthData = state.months[monthKey];
      if (!monthData || !Array.isArray(monthData.transactions)) continue;
      const idx = monthData.transactions.findIndex((tx) => tx.id === id);
      if (idx !== -1) {
        const tx = monthData.transactions[idx];
        if (tx.type === "recurringExpense" && tx.presetId && tx.date) {
          state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
          if (!state.ui.skippedRecurring || typeof state.ui.skippedRecurring !== "object") {
            state.ui.skippedRecurring = {};
          }
          if (!state.ui.skippedRecurring[monthKey]) {
            state.ui.skippedRecurring[monthKey] = {};
          }
          if (!state.ui.skippedRecurring[monthKey][tx.presetId]) {
            state.ui.skippedRecurring[monthKey][tx.presetId] = {};
          }
          state.ui.skippedRecurring[monthKey][tx.presetId][tx.date] = true;
        }
        monthData.transactions.splice(idx, 1);
        saveStateToServer();
        render();
        return;
      }
    }
  }

  function handleTransactionSubmit(event) {
    event.preventDefault();

    const type = transactionTypeInput.value;
    const category = transactionCategoryInput.value.trim();
    const title = transactionTitleInput.value.trim();
    const amount = Number(transactionAmountInput.value);
    const date = transactionDateInput.value;
    const note = transactionNoteInput.value.trim();

    if (!type || !["income", "fixedExpense", "flexibleExpense"].includes(type)) {
      alert("Неверный тип операции.");
      return;
    }
    if (!category) {
      alert("Выберите или добавьте категорию.");
      return;
    }
    if (!title) {
      alert("Введите название операции.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Введите корректную положительную сумму.");
      return;
    }

    const monthKeyFromDate = getMonthKeyFromDate(date);
    if (!monthKeyFromDate) {
      alert("Введите корректную дату.");
      return;
    }

    if (editingTransactionId) {
      let foundMonthKey = null;
      let existing = null;
      for (const mk of Object.keys(state.months || {})) {
        const tx = (state.months[mk].transactions || []).find((t) => t.id === editingTransactionId);
        if (tx) {
          foundMonthKey = mk;
          existing = tx;
          break;
        }
      }
      if (!existing) {
        alert("Не удалось найти операцию для редактирования. Она могла быть удалена.");
        editingTransactionId = null;
        render();
        return;
      }
      const targetMonthKey = monthKeyFromDate;
      if (targetMonthKey !== foundMonthKey) {
        state.months[foundMonthKey].transactions = state.months[foundMonthKey].transactions.filter(
          (t) => t.id !== editingTransactionId,
        );
        ensureMonth(state, targetMonthKey);
        state.months[targetMonthKey].transactions.push({
          id: existing.id,
          type,
          category,
          title,
          amount,
          date,
          note,
        });
      } else {
        existing.type = type;
        existing.category = category;
        existing.title = title;
        existing.amount = amount;
        existing.date = date;
        existing.note = note;
      }
      editingTransactionId = null;
    } else {
      const monthKey = monthSelect.value;
      if (!monthKey) {
        alert("Сначала выберите месяц.");
        return;
      }
      if (monthKeyFromDate !== monthKey) {
        const confirmMove = confirm(
          "Дата операции относится к другому месяцу. Всё равно сохранить её в текущем выбранном месяце?",
        );
        if (!confirmMove) {
          return;
        }
      }
      const monthData = ensureMonth(state, monthKey);
      const tx = {
        id: generateId(),
        type,
        category,
        title,
        amount,
        date,
        note,
      };
      monthData.transactions.push(tx);
      if (type === "income" && category === "Зарплата" && amount > 0) {
        const autoSave = Math.round(amount * 0.15);
        if (autoSave > 0) {
          monthData.transactions.push({
            id: generateId(),
            type: "savingTransfer",
            category: "Сбережения",
            title: "Авто-сбережения 15% от зарплаты",
            amount: autoSave,
            date,
            note: "",
          });
        }
      }
    }

    saveStateToServer();

    transactionAmountInput.value = "";
    transactionNoteInput.value = "";

    render();
  }

  function renderPresetList() {
    if (!presetListEl || !presetEmptyStateEl) return;
    const expensePresets = state.fixedExpensePresets || [];
    const incomePresets = state.incomePresets || [];
    const hasAny = expensePresets.length > 0 || incomePresets.length > 0;

    if (!hasAny) {
      presetEmptyStateEl.classList.remove("hidden");
      presetListEl.classList.add("hidden");
      presetListEl.innerHTML = "";
      return;
    }

    presetEmptyStateEl.classList.add("hidden");
    presetListEl.classList.remove("hidden");
    presetListEl.innerHTML = "";

    if (presetsHeaderSummaryEl) {
      const activeExpenses = expensePresets.filter((p) => p.active !== false).length;
      const activeIncomes = incomePresets.filter((p) => p.active !== false).length;
      const activeTotal = activeExpenses + activeIncomes;
      if (activeTotal === 0) {
        presetsHeaderSummaryEl.textContent = "Нет активных шаблонов";
      } else if (activeTotal === 1) {
        presetsHeaderSummaryEl.textContent = "1 активный шаблон";
      } else if (activeTotal >= 2 && activeTotal <= 4) {
        presetsHeaderSummaryEl.textContent = `${activeTotal} активных шаблона`;
      } else {
        presetsHeaderSummaryEl.textContent = `${activeTotal} активных шаблонов`;
      }
    }

    // Расходы (повторяемые)
    for (const preset of expensePresets) {
      const row = document.createElement("div");
      row.className =
        "flex items-center justify-between gap-2 px-1.5 py-1.5 text-[11px] border-b border-slate-800/70 last:border-b-0";

      const left = document.createElement("div");
      left.className = "flex flex-col";

      const title = document.createElement("span");
      title.textContent = preset.title || "Обязательный платёж";
      title.className = "text-slate-100";
      left.appendChild(title);

      const sub = document.createElement("span");
      sub.className = "text-[10px] text-slate-500";
      const dayStr = String(preset.dayOfMonth || "").padStart(2, "0");
      sub.textContent = `День: ${dayStr} · Категория: ${preset.category || "Повторяемый расход"} · Сумма: ${formatCurrency(
        Number(preset.amount) || 0,
      )}`;
      left.appendChild(sub);

      const right = document.createElement("div");
      right.className = "flex items-center gap-1.5";

      const activeToggle = document.createElement("button");
      activeToggle.type = "button";
      activeToggle.textContent = preset.active === false ? "Выкл" : "Вкл";
      activeToggle.className =
        "px-2 py-0.5 rounded-full text-[10px] border " +
        (preset.active === false
          ? "border-slate-500 text-slate-300"
          : "border-emerald-400/70 text-emerald-200 bg-emerald-500/10");
      onTap(activeToggle, () => {
        const isActivating = preset.active === false;
        preset.active = !preset.active;

        // Если шаблон снова активируем, снимаем "пропуски" для него,
        // чтобы повторяемые расходы снова начали появляться в планировании.
        if (isActivating) {
          state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
          if (
            state.ui.skippedRecurring &&
            typeof state.ui.skippedRecurring === "object"
          ) {
            for (const mKey of Object.keys(state.ui.skippedRecurring)) {
              const perMonth = state.ui.skippedRecurring[mKey];
              if (!perMonth || typeof perMonth !== "object") continue;
              if (perMonth[preset.id]) {
                delete perMonth[preset.id];
              }
              if (Object.keys(perMonth).length === 0) {
                delete state.ui.skippedRecurring[mKey];
              }
            }
          }
        }

        saveState(state);
        ensurePresetsForMonth(monthSelect.value);
        render();
      });
      right.appendChild(activeToggle);

      const editPresetBtn = document.createElement("button");
      editPresetBtn.type = "button";
      editPresetBtn.textContent = "✎";
      editPresetBtn.title = "Редактировать шаблон";
      editPresetBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-sky-600/80 hover:border-sky-500 hover:text-white transition-colors";
      onTap(editPresetBtn, () => {
        if (!presetForm) return;
        editingPresetId = preset.id;
        if (presetTitleInput) {
          presetTitleInput.value = preset.title || "";
        }
        if (presetCategoryInput) {
          renderPresetCategoryOptions();
          presetCategoryInput.value = preset.category || "";
        }
        if (presetAmountInput) {
          presetAmountInput.value =
            preset.amount != null && Number.isFinite(Number(preset.amount))
              ? String(preset.amount)
              : "";
        }
        if (presetDayInput) {
          presetDayInput.value = preset.dayOfMonth != null ? String(preset.dayOfMonth) : "";
        }
        presetForm.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      right.appendChild(editPresetBtn);

      const deletePresetBtn = document.createElement("button");
      deletePresetBtn.type = "button";
      deletePresetBtn.textContent = "×";
      deletePresetBtn.title = "Удалить шаблон";
      deletePresetBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-rose-600/80 hover:border-rose-500 hover:text-white transition-colors";
      onTap(deletePresetBtn, () => {
        state.fixedExpensePresets = (state.fixedExpensePresets || []).filter((p) => p.id !== preset.id);
        if (editingPresetId === preset.id) {
          editingPresetId = null;
          if (presetTitleInput) presetTitleInput.value = "";
          if (presetAmountInput) presetAmountInput.value = "";
          if (presetDayInput) presetDayInput.value = "";
        }
        Object.keys(state.months || {}).forEach((key) => {
          const m = state.months[key];
          if (!m || !Array.isArray(m.transactions)) return;
          m.transactions = m.transactions.filter((tx) => tx.presetId !== preset.id);
        });
        saveStateToServer();
        render();
      });
      right.appendChild(deletePresetBtn);

      row.appendChild(left);
      row.appendChild(right);

      presetListEl.appendChild(row);
    }

    // Доходы (планируемые)
    for (const preset of incomePresets) {
      const row = document.createElement("div");
      row.className =
        "flex items-center justify-between gap-2 px-1.5 py-1.5 text-[11px] border-b border-slate-800/70 last:border-b-0";

      const left = document.createElement("div");
      left.className = "flex flex-col";

      const title = document.createElement("span");
      title.textContent = preset.title || "Доход";
      title.className = "text-slate-100";
      left.appendChild(title);

      const sub = document.createElement("span");
      sub.className = "text-[10px] text-slate-500";
      const dayStr = String(preset.dayOfMonth || "").padStart(2, "0");
      sub.textContent = `Доход · День: ${dayStr} · Категория: ${preset.category || "Доход"} · Сумма: ${formatCurrency(
        Number(preset.amount) || 0,
      )}`;
      left.appendChild(sub);

      const right = document.createElement("div");
      right.className = "flex items-center gap-1.5";

      const activeToggle = document.createElement("button");
      activeToggle.type = "button";
      activeToggle.textContent = preset.active === false ? "Выкл" : "Вкл";
      activeToggle.className =
        "px-2 py-0.5 rounded-full text-[10px] border " +
        (preset.active === false
          ? "border-slate-500 text-slate-300"
          : "border-emerald-400/70 text-emerald-200 bg-emerald-500/10");
      onTap(activeToggle, () => {
        preset.active = !preset.active;
        saveState(state);
        ensureIncomePresetsForMonth(monthSelect.value);
        render();
      });
      right.appendChild(activeToggle);

      const editPresetBtn = document.createElement("button");
      editPresetBtn.type = "button";
      editPresetBtn.textContent = "✎";
      editPresetBtn.title = "Редактировать шаблон";
      editPresetBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-sky-600/80 hover:border-sky-500 hover:text-white transition-colors";
      onTap(editPresetBtn, () => {
        if (!presetForm) return;
        editingPresetId = preset.id;
        // помечаем, что редактируем доход
        state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
        state.ui.editingPresetKind = "income";
        if (presetTitleInput) {
          presetTitleInput.value = preset.title || "";
        }
        if (presetCategoryInput) {
          renderPresetCategoryOptions();
          presetCategoryInput.value = preset.category || "";
        }
        if (presetAmountInput) {
          presetAmountInput.value =
            preset.amount != null && Number.isFinite(Number(preset.amount))
              ? String(preset.amount)
              : "";
        }
        if (presetDayInput) {
          presetDayInput.value = preset.dayOfMonth != null ? String(preset.dayOfMonth) : "";
        }
        if (typeof document !== "undefined") {
          const presetTypeSelect = document.getElementById("presetType");
          if (presetTypeSelect) presetTypeSelect.value = "income";
        }
        presetForm.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      right.appendChild(editPresetBtn);

      const deletePresetBtn = document.createElement("button");
      deletePresetBtn.type = "button";
      deletePresetBtn.textContent = "×";
      deletePresetBtn.title = "Удалить шаблон";
      deletePresetBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-rose-600/80 hover:border-rose-500 hover:text-white transition-colors";
      onTap(deletePresetBtn, () => {
        state.incomePresets = (state.incomePresets || []).filter((p) => p.id !== preset.id);
        if (editingPresetId === preset.id) {
          editingPresetId = null;
          if (presetTitleInput) presetTitleInput.value = "";
          if (presetAmountInput) presetAmountInput.value = "";
          if (presetDayInput) presetDayInput.value = "";
        }
        Object.keys(state.months || {}).forEach((key) => {
          const m = state.months[key];
          if (!m || !Array.isArray(m.transactions)) return;
          m.transactions = m.transactions.filter((tx) => tx.presetId !== preset.id);
        });
        saveStateToServer();
        render();
      });
      right.appendChild(deletePresetBtn);

      row.appendChild(left);
      row.appendChild(right);

      presetListEl.appendChild(row);
    }
  }

  function renderIncomePresetList() {
    // Больше не используется отдельно: доходы и расходы отображаются в одном списке шаблонов.
    return;
  }

  function handlePresetSubmit(event) {
    event.preventDefault();

    const title = presetTitleInput.value.trim();
    const categoryRaw = (presetCategoryInput?.value || "").trim();
    const amount = Number(presetAmountInput.value);
    const dayRaw = presetDayInput.value.trim();
    const day = Number.parseInt(dayRaw || "1", 10);

    if (!title) {
      alert("Введите название повторяемого расхода.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Введите корректную положительную сумму для шаблона.");
      return;
    }
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      alert("День месяца должен быть числом от 1 до 31.");
      return;
    }

    const kind = presetTypeInput && presetTypeInput.value === "income" ? "income" : "expense";
    const isIncome = kind === "income";
    const category =
      categoryRaw ||
      (isIncome ? "Зарплата" : "Повторяемый расход");

    if (!Array.isArray(state.fixedExpensePresets)) {
      state.fixedExpensePresets = [];
    }
    if (!Array.isArray(state.incomePresets)) {
      state.incomePresets = [];
    }

    if (editingPresetId) {
      if (kind === "income") {
        const existingIncome = state.incomePresets.find((p) => p.id === editingPresetId);
        if (existingIncome) {
          existingIncome.title = title;
          existingIncome.category = category;
          existingIncome.amount = amount;
          existingIncome.dayOfMonth = day;
        }
      } else {
        const existing = state.fixedExpensePresets.find((p) => p.id === editingPresetId);
        if (existing) {
          existing.title = title;
          existing.category = category;
          existing.amount = amount;
          existing.dayOfMonth = day;
        }
      }
      editingPresetId = null;
    } else {
      const preset = {
        id: generateId(),
        title,
        category,
        amount,
        dayOfMonth: day,
        active: true,
      };
      if (isIncome) {
        state.incomePresets.push(preset);
      } else {
        state.fixedExpensePresets.push(preset);
      }
    }
    saveStateToServer();

    presetTitleInput.value = "";
    presetAmountInput.value = "";
    presetDayInput.value = "";

    ensurePresetsForMonth(monthSelect.value);
    ensureIncomePresetsForMonth(monthSelect.value);
    render();
  }


  function handleResetMonth() {
    const monthKey = monthSelect.value;
    if (!monthKey) return;
    const ok = confirm("Очистить все операции за выбранный месяц? Действие нельзя отменить.");
    if (!ok) return;
    if (state.months[monthKey]) {
      state.months[monthKey].transactions = [];
      saveStateToServer();
      render();
    }
  }

  function handleMonthOrDateChange() {
    render();
  }

  function handleFilterChange() {
    renderTransactionsList();
  }

  function openTodayBalanceEdit() {
    if (!todayBalanceEditRow || !todayBalanceInput) return;
    const currentDateStr = currentDateInput.value;
    if (!currentDateStr) {
      alert("Сначала выберите текущую дату в месяце.");
      return;
    }
    const startValue = lastBaseTodayRest;
    todayBalanceInput.value = startValue ? String(startValue) : "";
    if (todayBalanceCommentInput) {
      todayBalanceCommentInput.value = "";
    }
    todayBalanceEditRow.classList.remove("hidden");
  }

  function closeTodayBalanceEdit() {
    if (!todayBalanceEditRow) return;
    todayBalanceEditRow.classList.add("hidden");
    if (todayBalanceInput) todayBalanceInput.value = "";
    if (todayBalanceCommentInput) todayBalanceCommentInput.value = "";
  }

  function saveTodayBalanceEdit() {
    if (!todayBalanceInput) return;
    const currentDateStr = currentDateInput.value;
    if (!currentDateStr) {
      alert("Сначала выберите текущую дату в месяце.");
      return;
    }
    const raw = String(todayBalanceInput.value || "").replace(",", ".").trim();
    const newValue = Number(raw);
    if (!Number.isFinite(newValue)) {
      alert("Введите корректное число для остатка на сегодня.");
      return;
    }
    const note = todayBalanceCommentInput ? todayBalanceCommentInput.value.trim() : "";

    const monthKeyFromDate = getMonthKeyFromDate(currentDateStr);
    if (monthKeyFromDate) {
      const monthData = ensureMonth(state, monthKeyFromDate);
      const delta = newValue - lastBaseTodayRest;
      if (delta !== 0 || note) {
        monthData.transactions.push({
          id: generateId(),
          type: "balanceAdjustment",
          category: "Корректировка",
          title: "Корректировка остатка",
          amount: delta,
          date: currentDateStr,
          note: note || `Остаток установлен на ${formatCurrency(newValue)}`,
        });
      }
    }

    saveStateToServer();
    closeTodayBalanceEdit();
    render();
  }

  function maybeHandleMonthRollover() {
    const today = new Date();
    if (Number.isNaN(today.getTime())) return;
    const year = today.getFullYear();
    const monthNum = today.getMonth() + 1;
    const day = String(today.getDate()).padStart(2, "0");
    const monthStr = String(monthNum).padStart(2, "0");
    const currentMonthKey = `${year}-${monthStr}`;
    const todayStr = `${year}-${monthStr}-${day}`;

    state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    if (!state.ui.monthRolloverHandled || typeof state.ui.monthRolloverHandled !== "object") {
      state.ui.monthRolloverHandled = {};
    }
    if (state.ui.monthRolloverHandled[currentMonthKey]) return;

    const prevYear = monthNum === 1 ? year - 1 : year;
    const prevMonthNum = monthNum === 1 ? 12 : monthNum - 1;
    const prevMonthStr = String(prevMonthNum).padStart(2, "0");
    const prevMonthKey = `${prevYear}-${prevMonthStr}`;
    const prevMonthData = state.months[prevMonthKey];
    if (!prevMonthData || !Array.isArray(prevMonthData.transactions) || prevMonthData.transactions.length === 0) {
      state.ui.monthRolloverHandled[currentMonthKey] = true;
      saveStateToServer();
      return;
    }

    const uiObj = state.ui;
    const monthPeriods =
      uiObj.monthPeriods && typeof uiObj.monthPeriods === "object" ? uiObj.monthPeriods : {};
    const prevPeriod = monthPeriods[prevMonthKey] || {};
    const daysInPrevMonth = getDaysInMonth(prevYear, prevMonthNum - 1);
    const firstPrevDayStr = `${prevYear}-${prevMonthStr}-01`;
    const lastPrevDayStr = `${prevYear}-${prevMonthStr}-${String(daysInPrevMonth).padStart(2, "0")}`;
    const periodStartStr = prevPeriod.start || firstPrevDayStr;
    const periodEndStr = prevPeriod.end || lastPrevDayStr;

    const prevMetrics = computeMetricsForMonth(prevMonthKey, periodEndStr, periodStartStr, periodEndStr);
    const saldoPrev = prevMetrics.saldo || 0;
    if (saldoPrev <= 0) {
      state.ui.monthRolloverHandled[currentMonthKey] = true;
      saveStateToServer();
      return;
    }

    const carry = confirm(
      `Остаток гибкого бюджета за ${prevMonthKey}: ${formatCurrency(
        saldoPrev,
      )}.\nOK — перенести на новый период, Отмена — отправить в накопления.`,
    );

    const currentMonthData = ensureMonth(state, currentMonthKey);
    if (carry) {
      currentMonthData.transactions.push({
        id: generateId(),
        type: "balanceAdjustment",
        category: "Корректировка",
        title: "Перенос остатка из предыдущего месяца",
        amount: saldoPrev,
        date: todayStr,
        note: `Из месяца ${prevMonthKey}`,
      });
    } else {
      currentMonthData.transactions.push({
        id: generateId(),
        type: "savingTransfer",
        category: "Сбережения",
        title: "Перенос остатка из предыдущего месяца",
        amount: saldoPrev,
        date: todayStr,
        note: `Из месяца ${prevMonthKey}`,
      });
    }

    state.ui.monthRolloverHandled[currentMonthKey] = true;
    saveStateToServer();
  }

  function fillSalaryExample() {
    const currentMonthKey = monthSelect.value;
    if (!currentMonthKey) return;
    const [year, month] = currentMonthKey.split("-");
    const exampleDate = `${year}-${month}-05`;

    transactionTypeInput.value = "income";
    renderCategoryOptions();
    transactionCategoryInput.value = "Зарплата";
    transactionTitleInput.value = "Зарплата";
    transactionAmountInput.value = "100000";
    transactionDateInput.value = exampleDate;
    if (transactionDateLabel) {
      transactionDateLabel.textContent = `Дата операции: ${exampleDate}`;
    }
    transactionNoteInput.value = "Основной доход";
  }

  onTap(resetMonthButton, handleResetMonth);
  transactionForm.addEventListener("submit", handleTransactionSubmit);
  if (document.documentElement.classList.contains("ios-standalone")) {
    const transactionSubmitBtn = document.getElementById("transactionSubmitBtn");
    const presetSubmitBtn = document.getElementById("presetSubmitBtn");
    if (transactionSubmitBtn) onTap(transactionSubmitBtn, () => transactionForm.requestSubmit());
    if (presetForm && presetSubmitBtn) onTap(presetSubmitBtn, () => presetForm.requestSubmit());
  }
  transactionTypeInput.addEventListener("change", () => {
    renderCategoryOptions();
    applyTypeButtons();
  });
  monthSelect.addEventListener("change", () => {
    const monthKey = monthSelect.value;
    editingTransactionId = null;
    if (monthKey) {
      syncPeriodInputsForMonth(monthKey);
    }
    render();
  });
  currentDateInput.addEventListener("change", handleMonthOrDateChange);
  transactionsFilterInput.addEventListener("change", handleFilterChange);

  function setHistoryPeriodModeAndRefresh(mode) {
    setHistoryPeriodMode(mode);
    setDefaultHistoryPeriodInputs(mode);
    applyHistoryPeriodTabUI();
    renderTransactionsList();
  }

  if (historyPeriodTabDay) {
    historyPeriodTabDay.addEventListener("click", () => setHistoryPeriodModeAndRefresh("day"));
  }
  if (historyPeriodTabMonth) {
    historyPeriodTabMonth.addEventListener("click", () => setHistoryPeriodModeAndRefresh("month"));
  }
  if (historyPeriodTabRange) {
    historyPeriodTabRange.addEventListener("click", () => setHistoryPeriodModeAndRefresh("range"));
  }
  if (historyFilterDayInput) {
    historyFilterDayInput.addEventListener("change", () => renderTransactionsList());
  }
  if (historyFilterMonthInput) {
    historyFilterMonthInput.addEventListener("change", () => renderTransactionsList());
  }
  if (historyFilterRangeStartInput) {
    historyFilterRangeStartInput.addEventListener("change", () => renderTransactionsList());
  }
  if (historyFilterRangeEndInput) {
    historyFilterRangeEndInput.addEventListener("change", () => renderTransactionsList());
  }
  if (transactionsDateFilterClearButton) {
    onTap(transactionsDateFilterClearButton, () => {
      if (historyFilterDayInput) historyFilterDayInput.value = "";
      if (historyFilterMonthInput) historyFilterMonthInput.value = "";
      if (historyFilterRangeStartInput) historyFilterRangeStartInput.value = "";
      if (historyFilterRangeEndInput) historyFilterRangeEndInput.value = "";
      setDefaultHistoryPeriodInputs("day");
      setDefaultHistoryPeriodInputs("month");
      setDefaultHistoryPeriodInputs("range");
      renderTransactionsList();
    });
  }
  if (todayBalanceEditButton) {
    onTap(todayBalanceEditButton, openTodayBalanceEdit);
  }
  if (todayBalanceSaveButton) {
    onTap(todayBalanceSaveButton, saveTodayBalanceEdit);
  }
  if (todayBalanceCancelButton) {
    onTap(todayBalanceCancelButton, closeTodayBalanceEdit);
  }
  onTap(fillSalaryExampleButton, fillSalaryExample);
  onTap(addCategoryButton, addCategoryForCurrentType);
  if (typeExpenseButton) {
    onTap(typeExpenseButton, () => {
      transactionTypeInput.value = "flexibleExpense";
      renderCategoryOptions();
      applyTypeButtons();
    });
  }
  if (typeIncomeButton) {
    onTap(typeIncomeButton, () => {
      transactionTypeInput.value = "income";
      renderCategoryOptions();
      applyTypeButtons();
    });
  }
  if (presetTypeExpenseButton) {
    onTap(presetTypeExpenseButton, () => {
      if (presetTypeInput) presetTypeInput.value = "expense";
      if (state.ui) delete state.ui.editingPresetKind;
      renderPresetCategoryOptions();
      presetTypeExpenseButton.className =
        "px-2.5 py-1 rounded-full text-[11px] font-medium text-emerald-100 bg-emerald-500/20 border border-emerald-400/80";
      if (presetTypeIncomeButton) {
        presetTypeIncomeButton.className =
          "px-2.5 py-1 rounded-full text-[11px] font-medium text-slate-300";
      }
    });
  }
  if (presetTypeIncomeButton) {
    onTap(presetTypeIncomeButton, () => {
      if (presetTypeInput) presetTypeInput.value = "income";
      renderPresetCategoryOptions();
      presetTypeIncomeButton.className =
        "px-2.5 py-1 rounded-full text-[11px] font-medium text-emerald-100 bg-emerald-500/20 border border-emerald-400/80";
      if (presetTypeExpenseButton) {
        presetTypeExpenseButton.className =
          "px-2.5 py-1 rounded-full text-[11px] font-medium text-slate-300";
      }
    });
  }
  if (expenseKindNormalButton) {
    onTap(expenseKindNormalButton, () => {
      transactionTypeInput.value = "flexibleExpense";
      renderCategoryOptions();
      applyTypeButtons();
    });
  }
  if (expenseKindFixedButton) {
    onTap(expenseKindFixedButton, () => {
      transactionTypeInput.value = "fixedExpense";
      renderCategoryOptions();
      applyTypeButtons();
    });
  }
  if (transactionDateToggleButton && transactionDateRow) {
    onTap(transactionDateToggleButton, () => {
      const isHidden = transactionDateRow.classList.toggle("hidden");
      transactionDateToggleButton.textContent = isHidden ? "Изменить дату" : "Скрыть дату";
    });
  }
  if (transactionDateInput && transactionDateLabel) {
    transactionDateInput.addEventListener("change", () => {
      const v = transactionDateInput.value;
      if (v) {
        transactionDateLabel.textContent = `Дата операции: ${v}`;
      } else {
        transactionDateLabel.textContent = "";
      }
    });
  }
  if (headerAddOperationButton) {
    onTap(headerAddOperationButton, () => {
      setActiveTab("operations", true);
      focusTransactionForm();
    });
  }
  // авторизация отключена в локальном режиме, обработчики не вешаем
  function openMonthDetailsModal() {
    if (!monthDetailsModal) return;
    monthDetailsModal.classList.remove("hidden");
    monthDetailsModal.classList.add("flex");
  }
  function closeMonthDetailsModal() {
    if (!monthDetailsModal) return;
    monthDetailsModal.classList.add("hidden");
    monthDetailsModal.classList.remove("flex");
  }
  if (editMonthDetailsButton) {
    onTap(editMonthDetailsButton, openMonthDetailsModal);
  }
  if (closeMonthDetailsButton) {
    onTap(closeMonthDetailsButton, closeMonthDetailsModal);
  }
  if (monthDetailsModal) {
    monthDetailsModal.addEventListener("click", (e) => {
      if (e.target === monthDetailsModal) {
        closeMonthDetailsModal();
      }
    });
  }

  if (editTransactionForm) {
    editTransactionForm.addEventListener("submit", handleEditTransactionSubmit);
  }
  if (closeEditTransactionButton) {
    closeEditTransactionButton.addEventListener("click", closeEditTransactionModal);
  }
  if (cancelEditTransactionButton) {
    cancelEditTransactionButton.addEventListener("click", closeEditTransactionModal);
  }
  if (editTransactionModal) {
    editTransactionModal.addEventListener("click", (e) => {
      if (e.target === editTransactionModal) {
        closeEditTransactionModal();
      }
    });
  }
  if (editTypeExpenseButton) {
    editTypeExpenseButton.addEventListener("click", () => {
      if (editTransactionTypeInput) editTransactionTypeInput.value = "flexibleExpense";
      renderEditModalCategoryOptions("flexibleExpense");
      editTypeExpenseButton.className =
        "flex-1 rounded-xl border border-rose-400/80 bg-rose-500/20 text-rose-100 px-3 py-2.5 text-xs font-semibold transition-colors";
      editTypeIncomeButton.className =
        "flex-1 rounded-xl border border-slate-700/80 bg-slate-900/80 text-slate-100 hover:bg-slate-800 px-3 py-2.5 text-xs font-semibold transition-colors";
    });
  }
  if (editTypeIncomeButton) {
    editTypeIncomeButton.addEventListener("click", () => {
      if (editTransactionTypeInput) editTransactionTypeInput.value = "income";
      renderEditModalCategoryOptions("income");
      editTypeIncomeButton.className =
        "flex-1 rounded-xl border border-emerald-400/80 bg-emerald-500/20 text-emerald-100 px-3 py-2.5 text-xs font-semibold transition-colors";
      editTypeExpenseButton.className =
        "flex-1 rounded-xl border border-slate-700/80 bg-slate-900/80 text-slate-100 hover:bg-slate-800 px-3 py-2.5 text-xs font-semibold transition-colors";
    });
  }
  if (periodStartInput) {
    periodStartInput.addEventListener("change", updatePeriodInfo);
  }
  if (periodEndInput) {
    periodEndInput.addEventListener("change", updatePeriodInfo);
  }

  initDefaultDates();
  renderCategoryOptions();
  applyTypeButtons();
  renderPresetCategoryOptions();
  if (presetForm) {
    presetForm.addEventListener("submit", handlePresetSubmit);
  }
  ensurePresetsForMonth(monthSelect.value);
  ensureIncomePresetsForMonth(monthSelect.value);
  applyPanelVisibilityFromState();
  applyInitialTabFromState();
  applyAuthUi();
  setDefaultHistoryPeriodInputs(getHistoryPeriodMode());
  applyHistoryPeriodTabUI();
  function bindTab(button, tab, extra) {
    if (!button) return;
    button.addEventListener("click", () => {
      setActiveTab(tab, true);
      if (extra) extra();
    });
  }
  bindTab(tabOperationsButton, "operations");
  bindTab(tabDashboardButton, "dashboard");
  bindTab(tabHistoryButton, "history");
  bindTab(tabPresetsButton, "presets");
  bindTab(tabAnalyticsButton, "analytics", renderAnalyticsTable);

  maybeHandleMonthRollover();
  render();
});

