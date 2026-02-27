const STORAGE_KEY = "financePlannerData_v2";
const LEGACY_STORAGE_KEYS = ["financePlannerData_v1"];

const DEFAULT_CATEGORIES = {
  income: ["Зарплата", "Премия", "Фриланс"],
  fixedExpense: ["Аренда", "Ипотека/кредит", "Коммуналка", "Подписки"],
  flexibleExpense: ["Продукты", "Кафе/рестораны", "Транспорт", "Развлечения", "Одежда"],
};

function loadState() {
  try {
    const rawCurrent = localStorage.getItem(STORAGE_KEY);
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
        ui: { monthPeriods: {} },
      };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        months: {},
        categories: { ...DEFAULT_CATEGORIES },
        fixedExpensePresets: [],
        ui: { monthPeriods: {} },
      };
    }

    const months = parsed.months && typeof parsed.months === "object" ? parsed.months : {};
    const categoriesFromStorage =
      parsed.categories && typeof parsed.categories === "object" ? parsed.categories : {};
    const presetsFromStorage = Array.isArray(parsed.fixedExpensePresets)
      ? parsed.fixedExpensePresets
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

    const uiRaw = parsed.ui && typeof parsed.ui === "object" ? parsed.ui : {};
    const monthPeriods =
      uiRaw.monthPeriods && typeof uiRaw.monthPeriods === "object" ? uiRaw.monthPeriods : {};
    const ui = { ...uiRaw, monthPeriods };

    const state = { months, categories, fixedExpensePresets, ui };

    // Если мы загрузились из legacy-ключа (v1), один раз мигрируем данные в новый STORAGE_KEY.
    if (loadedFromLegacy) {
      saveState(state);
    }

    return state;
  } catch {
    return {
      months: {},
      categories: { ...DEFAULT_CATEGORIES },
      fixedExpensePresets: [],
      ui: { monthPeriods: {} },
    };
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

  const transactionsFilterInput = document.getElementById("transactionsFilter");
  const transactionsDateFilterInput = document.getElementById("transactionsDateFilter");
  const transactionsDateFilterClearButton = document.getElementById("transactionsDateFilterClear");
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

  const presetForm = document.getElementById("presetForm");
  const presetTitleInput = document.getElementById("presetTitle");
  const presetCategoryInput = document.getElementById("presetCategory");
  const presetAmountInput = document.getElementById("presetAmount");
  const presetDayInput = document.getElementById("presetDay");
  const presetListEl = document.getElementById("presetList");
  const presetEmptyStateEl = document.getElementById("presetEmptyState");
  const editMonthDetailsButton = document.getElementById("editMonthDetailsButton");
  const monthDetailsModal = document.getElementById("monthDetailsModal");
  const closeMonthDetailsButton = document.getElementById("closeMonthDetailsButton");

  let state = loadState();
  let editingTransactionId = null;
  let editingPresetId = null;

  function getCategoriesForType(type) {
    if (!state.categories) {
      state.categories = { ...DEFAULT_CATEGORIES };
    }
    if (!state.categories[type]) {
      state.categories[type] = [...DEFAULT_CATEGORIES[type]];
    }
    return state.categories[type];
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
  }

  function renderPresetCategoryOptions() {
    if (!presetCategoryInput) return;
    const categories = getCategoriesForType("fixedExpense");
    presetCategoryInput.innerHTML = "";
    for (const cat of categories) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      presetCategoryInput.appendChild(opt);
    }
  }

  function startEditTransaction(tx) {
    if (!tx || !transactionForm) return;

    if (tx.type === "recurringExpense") {
      alert("Автоматические повторяемые расходы редактируются через шаблоны, а не напрямую.");
      return;
    }

    editingTransactionId = tx.id;

    if (transactionTypeInput) {
      transactionTypeInput.value = tx.type || "flexibleExpense";
    }
    renderCategoryOptions();

    const typeForCategories = transactionTypeInput.value || "flexibleExpense";
    const cats = getCategoriesForType(typeForCategories);
    if (tx.category && !cats.includes(tx.category)) {
      cats.push(tx.category);
      state.categories[typeForCategories] = cats;
      saveState(state);
      renderCategoryOptions();
    }

    if (transactionCategoryInput && tx.category) {
      transactionCategoryInput.value = tx.category;
    }
    if (transactionTitleInput) {
      transactionTitleInput.value = tx.title || "";
    }
    if (transactionAmountInput) {
      transactionAmountInput.value = tx.amount != null ? String(tx.amount) : "";
    }
    if (transactionDateInput) {
      transactionDateInput.value = tx.date || "";
    }
    if (transactionNoteInput) {
      transactionNoteInput.value = tx.note || "";
    }

    focusTransactionForm();
  }

  function applyPanelVisibilityFromState() {
    // Панель месяца теперь открывается во всплывающем окне, состояние не храним
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

    if (transactionsCard) {
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
    saveState(state);

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
    let spentSoFar = 0;
    let spentToday = 0;

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
      const amount = Number(tx.amount) || 0;
      const txDate = tx.date || "";
      const inPeriod =
        (!periodStartStr || (txDate && txDate >= periodStartStr)) &&
        (!periodEndStr || (txDate && txDate <= periodEndStr));
      if (!inPeriod) continue;

      if (tx.type === "income") {
        totalIncome += amount;
        if (tx.category === "Зарплата") {
          totalSalaryIncome += amount;
        }
      } else if (tx.type === "fixedExpense" || tx.type === "recurringExpense") {
        totalFixed += amount;
      } else if (tx.type === "flexibleExpense") {
        flexibleExpensesTotal += amount;
        if (tx.date && currentDateStr && tx.date <= currentDateStr) {
          spentSoFar += amount;
        }
        if (tx.date && currentDateStr && tx.date === currentDateStr) {
          spentToday += amount;
        }
      }
    }

    const autoSavings = totalSalaryIncome * 0.1;
    const flexibleBudget = totalIncome - totalFixed - autoSavings;
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
      currentDailyLimitEl.textContent = formatCurrency(0);
      spentSoFarEl.textContent = formatCurrency(0);
      if (todayRecommendedEl) {
        todayRecommendedEl.textContent = formatCurrency(0);
      }
      if (todaySpentEl) {
        todaySpentEl.textContent = formatCurrency(0);
      }
      monthSaldoEl.textContent = formatCurrency(0);
      monthDaysEl.textContent = "—";
      currentDayNumberEl.textContent = "—";
      warningsListEl.innerHTML =
        '<li class="text-[11px] text-slate-400">Выберите месяц, чтобы начать планирование.</li>';
      return;
    }

    ensurePresetsForMonth(monthKey);
    const metrics = computeMetricsForMonth(monthKey, currentDateStr, periodStartStr, periodEndStr);

    totalIncomeEl.textContent = formatCurrency(metrics.totalIncome);
    totalFixedExpensesEl.textContent = formatCurrency(metrics.totalFixed);
    autoSavingsEl.textContent = formatCurrency(metrics.autoSavings);
    flexibleBudgetEl.textContent = formatCurrency(metrics.flexibleBudget);
    plannedDailyLimitEl.textContent = formatCurrency(Math.max(metrics.plannedDailyLimit, 0));
    currentDailyLimitEl.textContent = formatCurrency(Math.max(metrics.currentDailyLimit, 0));
    spentSoFarEl.textContent = formatCurrency(metrics.spentSoFar);
    if (todayRecommendedEl) {
      todayRecommendedEl.textContent = formatCurrency(Math.max(metrics.currentDailyLimit, 0));
    }
    if (todaySpentEl) {
      todaySpentEl.textContent = formatCurrency(metrics.spentToday || 0);
    }
    if (totalFlexibleExpensesEl) {
      totalFlexibleExpensesEl.textContent = formatCurrency(metrics.flexibleExpensesTotal || 0);
    }
    monthSaldoEl.textContent = formatCurrency(metrics.saldo);

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

  function renderTransactionsList() {
    const monthKey = monthSelect.value;
    const typeFilter = transactionsFilterInput.value;
    const dateFilter = transactionsDateFilterInput ? transactionsDateFilterInput.value : "";
    const monthData = state.months[monthKey];
    const transactions = monthData?.transactions || [];

    let filtered = transactions;
    if (typeFilter !== "all") {
      filtered = filtered.filter((tx) => tx.type === typeFilter);
    }
    if (dateFilter) {
      filtered = filtered.filter((tx) => tx.date === dateFilter);
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

  function deleteTransaction(id) {
    const monthKey = monthSelect.value;
    const monthData = state.months[monthKey];
    if (!monthData) return;
    monthData.transactions = monthData.transactions.filter((tx) => tx.id !== id);
    saveState(state);
    render();
  }

  function handleTransactionSubmit(event) {
    event.preventDefault();

    const monthKey = monthSelect.value;
    if (!monthKey) {
      alert("Сначала выберите месяц.");
      return;
    }

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
    if (monthKeyFromDate !== monthKey) {
      const confirmMove = confirm(
        "Дата операции относится к другому месяцу. Всё равно сохранить её в текущем выбранном месяце?",
      );
      if (!confirmMove) {
        return;
      }
    }

    const monthData = ensureMonth(state, monthKey);

    if (editingTransactionId) {
      const existing = monthData.transactions.find((tx) => tx.id === editingTransactionId);
      if (!existing) {
        alert("Не удалось найти операцию для редактирования. Она могла быть удалена.");
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
      monthData.transactions.push({
        id: generateId(),
        type,
        category,
        title,
        amount,
        date,
        note,
      });
    }

    saveState(state);

    transactionAmountInput.value = "";
    transactionNoteInput.value = "";

    render();
  }

  function renderPresetList() {
    if (!presetListEl || !presetEmptyStateEl) return;
    const presets = state.fixedExpensePresets || [];

    if (presets.length === 0) {
      presetEmptyStateEl.classList.remove("hidden");
      presetListEl.classList.add("hidden");
      presetListEl.innerHTML = "";
      return;
    }

    presetEmptyStateEl.classList.add("hidden");
    presetListEl.classList.remove("hidden");
    presetListEl.innerHTML = "";

    if (presetsHeaderSummaryEl) {
      const activeCount = presets.filter((p) => p.active !== false).length;
      if (activeCount === 0) {
        presetsHeaderSummaryEl.textContent = "Нет активных повторяемых расходов";
      } else if (activeCount === 1) {
        presetsHeaderSummaryEl.textContent = "1 активный повторяемый расход";
      } else if (activeCount >= 2 && activeCount <= 4) {
        presetsHeaderSummaryEl.textContent = `${activeCount} активных повторяемых расхода`;
      } else {
        presetsHeaderSummaryEl.textContent = `${activeCount} активных повторяемых расходов`;
      }
    }

    for (const preset of presets) {
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
        preset.active = !preset.active;
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
        saveState(state);
        render();
      });
      right.appendChild(deletePresetBtn);

      row.appendChild(left);
      row.appendChild(right);

      presetListEl.appendChild(row);
    }
  }

  function handlePresetSubmit(event) {
    event.preventDefault();

    const title = presetTitleInput.value.trim();
    const category = (presetCategoryInput?.value || "").trim() || "Повторяемый расход";
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

    if (!Array.isArray(state.fixedExpensePresets)) {
      state.fixedExpensePresets = [];
    }

    if (editingPresetId) {
      const existing = state.fixedExpensePresets.find((p) => p.id === editingPresetId);
      if (existing) {
        existing.title = title;
        existing.category = category;
        existing.amount = amount;
        existing.dayOfMonth = day;
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
      state.fixedExpensePresets.push(preset);
    }
    saveState(state);

    presetTitleInput.value = "";
    presetAmountInput.value = "";
    presetDayInput.value = "";

    ensurePresetsForMonth(monthSelect.value);
    render();
  }

  function handleResetMonth() {
    const monthKey = monthSelect.value;
    if (!monthKey) return;
    const ok = confirm("Очистить все операции за выбранный месяц? Действие нельзя отменить.");
    if (!ok) return;
    if (state.months[monthKey]) {
      state.months[monthKey].transactions = [];
      saveState(state);
      render();
    }
  }

  function handleMonthOrDateChange() {
    render();
  }

  function handleFilterChange() {
    renderTransactionsList();
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
  if (transactionsDateFilterInput) {
    transactionsDateFilterInput.addEventListener("change", handleFilterChange);
  }
  if (transactionsDateFilterClearButton) {
    onTap(transactionsDateFilterClearButton, () => {
      transactionsDateFilterInput.value = "";
      renderTransactionsList();
    });
  }
  onTap(fillSalaryExampleButton, fillSalaryExample);
  onTap(addCategoryButton, addCategoryForCurrentType);
  if (headerAddOperationButton) {
    onTap(headerAddOperationButton, () => {
      setActiveTab("operations", true);
      focusTransactionForm();
    });
  }
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
  if (periodStartInput) {
    periodStartInput.addEventListener("change", updatePeriodInfo);
  }
  if (periodEndInput) {
    periodEndInput.addEventListener("change", updatePeriodInfo);
  }

  initDefaultDates();
  renderCategoryOptions();
  renderPresetCategoryOptions();
  if (presetForm) {
    presetForm.addEventListener("submit", handlePresetSubmit);
  }
  ensurePresetsForMonth(monthSelect.value);
  applyPanelVisibilityFromState();
  applyInitialTabFromState();
  if (tabOperationsButton) {
    onTap(tabOperationsButton, () => setActiveTab("operations", true));
  }
  if (tabDashboardButton) {
    onTap(tabDashboardButton, () => setActiveTab("dashboard", true));
  }
  if (tabHistoryButton) {
    onTap(tabHistoryButton, () => setActiveTab("history", true));
  }
  if (tabPresetsButton) {
    onTap(tabPresetsButton, () => setActiveTab("presets", true));
  }
  if (tabAnalyticsButton) {
    onTap(tabAnalyticsButton, () => {
      setActiveTab("analytics", true);
      renderAnalyticsTable();
    });
  }
  setupPanelToggle(toggleMonthPanelButton, monthPanelBody, "monthPanelExpanded");
  render();
});

