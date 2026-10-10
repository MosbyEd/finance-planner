const BASE_STORAGE_KEY = "financePlannerData_v2";
let STORAGE_KEY = BASE_STORAGE_KEY;
const LEGACY_STORAGE_KEYS = ["financePlannerData_v1"];

const DEFAULT_CATEGORIES = {
  income: ["Зарплата", "Премия", "Фриланс"],
  fixedExpense: ["Аренда", "Ипотека/кредит", "Коммуналка", "Подписки"],
  flexibleExpense: ["Продукты", "Кафе/рестораны", "Транспорт", "Развлечения", "Одежда", "Сбережения"],
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
        loans: [],
        goals: [],
        ui: {
          monthPeriods: {},
          todayBalanceOverrides: {},
          monthRolloverHandled: {},
          skippedRecurring: {},
          aiDailyRecommendations: {},
        },
      };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        months: {},
        categories: { ...DEFAULT_CATEGORIES },
        fixedExpensePresets: [],
        incomePresets: [],
        loans: [],
        goals: [],
        ui: {
          monthPeriods: {},
          todayBalanceOverrides: {},
          monthRolloverHandled: {},
          skippedRecurring: {},
          aiDailyRecommendations: {},
        },
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
        // сохраняем, если задано, с какого месяца должен начать работать шаблон
        startMonthKey:
          typeof p.startMonthKey === "string" && p.startMonthKey.length >= 7
            ? p.startMonthKey
            : undefined,
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
        startMonthKey:
          typeof p.startMonthKey === "string" && p.startMonthKey.length >= 7
            ? p.startMonthKey
            : undefined,
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
    const aiDailyRecommendations =
      uiRaw.aiDailyRecommendations && typeof uiRaw.aiDailyRecommendations === "object"
        ? uiRaw.aiDailyRecommendations
        : {};
    const ui = {
      ...uiRaw,
      monthPeriods,
      monthRolloverHandled,
      skippedRecurring,
      aiDailyRecommendations,
    };

    const loans = Array.isArray(parsed.loans) ? parsed.loans : [];
    const goals = Array.isArray(parsed.goals) ? parsed.goals : [];

    const state = { months, categories, fixedExpensePresets, incomePresets, loans, goals, ui };

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
      loans: [],
      goals: [],
      ui: { monthPeriods: {}, monthRolloverHandled: {}, skippedRecurring: {} },
    };
  }
}

function saveState(state) {
    if (!state || typeof state !== "object") return;
    if (!state.ui || typeof state.ui !== "object") state.ui = {};
    state.ui.lastSyncedAt = Date.now();

    const json = JSON.stringify(state);
    localStorage.setItem(BASE_STORAGE_KEY, json);

    fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
      credentials: "include",
    }).catch(() => {});
  }

  async function loadStateFromServerAsync() {
  try {
      const res = await fetch("/api/state", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
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

/** Парсит сумму из строки ввода: убирает пробелы, заменяет запятую на точку, поддерживает "200 000" и "200.000". */
function parseAmountFromInput(str) {
  if (str == null) return NaN;
  let s = String(str).replace(/\s/g, "").replace(/\u00A0/g, "").trim();
  if (s === "") return NaN;
  s = s.replace(",", ".");
  // Точка как разделитель тысяч (например "200.000"): если после точки ровно 3 цифры и больше ничего — убрать точку
  const dotIdx = s.indexOf(".");
  if (dotIdx !== -1 && /^\d{3}$/.test(s.slice(dotIdx + 1)) && s.length === dotIdx + 4) {
    s = s.slice(0, dotIdx) + s.slice(dotIdx + 1);
  }
  return Number(s);
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
  const totalIncomePlannedEl = document.getElementById("totalIncomePlanned");
  const totalFixedExpensesEl = document.getElementById("totalFixedExpenses");
  const totalFixedPlannedEl = document.getElementById("totalFixedPlanned");
  const flexibleBudgetEl = document.getElementById("flexibleBudget");
  const autoSavingsRealEl = document.getElementById("autoSavingsReal");
  const autoSavingsEl = document.getElementById("autoSavings");
  const plannedDailyLimitEl = document.getElementById("plannedDailyLimit");
  const plannedDailyLimitHelpButton = document.getElementById("plannedDailyLimitHelpButton");
  const currentDailyLimitEl = document.getElementById("currentDailyLimit");
  const spentSoFarEl = document.getElementById("spentSoFar");
  const totalFlexibleExpensesEl = document.getElementById("totalFlexibleExpenses");
  const todayRecommendedEl = document.getElementById("todayRecommended");
  const todayRecommendedLabelEl = document.getElementById("todayRecommendedLabel");
  const todayRecommendedAfterEl = document.getElementById("todayRecommendedAfter");
  const todayRecommendedAfterValueEl = document.getElementById("todayRecommendedAfterValue");
  const todayRecommendedRefreshReasoning = document.getElementById("todayRecommendedRefreshReasoning");
  const todayRecommendedRefreshFast = document.getElementById("todayRecommendedRefreshFast");
  const todayRecommendedUpdatedAtEl = document.getElementById("todayRecommendedUpdatedAt");
  const todayRecommendedExplainButton = document.getElementById(
    "todayRecommendedExplainButton",
  );
  const todaySpentEl = document.getElementById("todaySpent");
  const todaySpentRemainderEl = document.getElementById("todaySpentRemainder");
  const monthSaldoEl = document.getElementById("monthSaldo");
  const saldoBadgeEl = document.getElementById("saldoBadge");
  const warningsListEl = document.getElementById("warningsList");

  const aiDailyExplainModal = document.getElementById("aiDailyExplainModal");
  const aiDailyExplainText = document.getElementById("aiDailyExplainText");
  const aiDailyExplainCloseButton = document.getElementById("aiDailyExplainCloseButton");

  const savingsDepositOpenButton = document.getElementById("savingsDepositOpenButton");
  const savingsDepositModal = document.getElementById("savingsDepositModal");
  const savingsDepositCloseButton = document.getElementById("savingsDepositCloseButton");
  const savingsDepositCancelButton = document.getElementById("savingsDepositCancelButton");
  const savingsDepositForm = document.getElementById("savingsDepositForm");
  const savingsDepositAmountInput = document.getElementById("savingsDepositAmount");
  const savingsDepositDateInput = document.getElementById("savingsDepositDate");
  const savingsDepositNoteInput = document.getElementById("savingsDepositNote");

  const tabGoalsButton = document.getElementById("tabGoals");
  const tabLoansButton = document.getElementById("tabLoans");

  const goalsSection = document.getElementById("goalsSection");
  const goalsListEl = document.getElementById("goalsList");
  const goalsEmptyStateEl = document.getElementById("goalsEmptyState");
  const goalForm = document.getElementById("goalForm");
  const goalNameInput = document.getElementById("goalName");
  const goalCategoryInput = document.getElementById("goalCategory");
  const goalTargetAmountInput = document.getElementById("goalTargetAmount");
  const goalDueDateInput = document.getElementById("goalDueDate");
  const goalNoteInput = document.getElementById("goalNote");

  const goalEditModal = document.getElementById("goalEditModal");
  const goalEditForm = document.getElementById("goalEditForm");
  const goalEditCloseButton = document.getElementById("goalEditCloseButton");
  const goalEditCancelButton = document.getElementById("goalEditCancelButton");
  const goalEditNameInput = document.getElementById("goalEditName");
  const goalEditCategoryInput = document.getElementById("goalEditCategory");
  const goalEditTargetAmountInput = document.getElementById("goalEditTargetAmount");
  const goalEditCurrentAmountDisplay = document.getElementById("goalEditCurrentAmountDisplay");
  const goalEditDueDateInput = document.getElementById("goalEditDueDate");
  const goalEditNoteInput = document.getElementById("goalEditNote");

  const goalActionModal = document.getElementById("goalActionModal");
  const goalActionTitleEl = document.getElementById("goalActionTitle");
  const goalActionCloseButton = document.getElementById("goalActionCloseButton");
  const goalActionCancelButton = document.getElementById("goalActionCancelButton");
  const goalActionForm = document.getElementById("goalActionForm");
  const goalActionAmountInput = document.getElementById("goalActionAmount");
  const goalActionDateInput = document.getElementById("goalActionDate");
  const goalActionNoteInput = document.getElementById("goalActionNote");
  const goalActionSubmitButton = document.getElementById("goalActionSubmitButton");

  const loansSection = document.getElementById("loansSection");
  const loansListEl = document.getElementById("loansList");
  const loansEmptyStateEl = document.getElementById("loansEmptyState");
  const loanForm = document.getElementById("loanForm");
  const loanKindInput = document.getElementById("loanKind");
  const loanNameInput = document.getElementById("loanName");
  const loanAmountInput = document.getElementById("loanAmount");
  const loanDueDateInput = document.getElementById("loanDueDate");
  const loanNoteInput = document.getElementById("loanNote");

  const loanActionModal = document.getElementById("loanActionModal");
  const loanActionTitleEl = document.getElementById("loanActionTitle");
  const loanActionCloseButton = document.getElementById("loanActionCloseButton");
  const loanActionCancelButton = document.getElementById("loanActionCancelButton");
  const loanActionForm = document.getElementById("loanActionForm");
  const loanActionAmountInput = document.getElementById("loanActionAmount");
  const loanActionDateInput = document.getElementById("loanActionDate");
  const loanActionNoteInput = document.getElementById("loanActionNote");
  const loanActionSubmitButton = document.getElementById("loanActionSubmitButton");

  const loanEditModal = document.getElementById("loanEditModal");
  const loanEditCloseButton = document.getElementById("loanEditCloseButton");
  const loanEditCancelButton = document.getElementById("loanEditCancelButton");
  const loanEditForm = document.getElementById("loanEditForm");
  const loanEditKindInput = document.getElementById("loanEditKind");
  const loanEditNameInput = document.getElementById("loanEditName");
  const loanEditAmountInput = document.getElementById("loanEditAmount");
  const loanEditBalanceInput = document.getElementById("loanEditBalance");
  const loanEditDueDateInput = document.getElementById("loanEditDueDate");
  const loanEditNoteInput = document.getElementById("loanEditNote");

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
  const expenseRepeatCheckbox = document.getElementById("expenseRepeatCheckbox");
  const expenseRepeatRow = document.getElementById("expenseRepeatRow");
  const expenseTransferCheckbox = document.getElementById("expenseTransferCheckbox");
  const expenseTransferRow = document.getElementById("expenseTransferRow");
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
  const historyPeriodTotalsEl = document.getElementById("historyPeriodTotals");
  const toggleTransactionsPanelButton = null;
  const transactionsPanelBody = document.getElementById("transactionsPanelBody");
  const exportDataButton = document.getElementById("exportDataButton");
  const importDataButton = document.getElementById("importDataButton");
  const importDataInput = document.getElementById("importDataInput");
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
  const addOperationCard = document.getElementById("addOperationModal");
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

  const addOperationModal = document.getElementById("addOperationModal");
  const closeAddOperationModalButton = document.getElementById("closeAddOperationModalButton");

  const accountLabelEl = document.getElementById("accountLabel");
  const accountLoginEl = document.getElementById("accountLogin");
  const syncLabelValueEl = document.getElementById("syncLabelValue");
  const openAuthModalButtonEl = document.getElementById("openAuthModalButton");
  const authModalEl = document.getElementById("authModal");
  const authModalCloseButtonEl = document.getElementById("authModalCloseButton");
  const loginFormEl = document.getElementById("authForm");
  const loginButton = document.getElementById("loginButton");
  const goToRegisterButtonEl = document.getElementById("goToRegisterButton");
  const goToLoginButtonEl = document.getElementById("goToLoginButton");
  const loginInputEl = document.getElementById("loginInput");
  const passwordInputEl = document.getElementById("passwordInput");
  const logoutButtonEl = document.getElementById("logoutButton");
  const registerSubmitButtonEl = document.getElementById("registerSubmitButton");
  const authErrorEl = document.getElementById("authError");
  const authRegisterErrorEl = document.getElementById("authRegisterError");
  const authLoginViewEl = document.getElementById("authLoginView");
  const authRegisterViewEl = document.getElementById("authRegisterView");
  const authProfileViewEl = document.getElementById("authProfileView");
  const authDescriptionEl = document.getElementById("authDescription");
  const registerNameInputEl = document.getElementById("registerNameInput");
  const registerLoginInputEl = document.getElementById("registerLoginInput");
  const registerPasswordInputEl = document.getElementById("registerPasswordInput");
  const registerPasswordRepeatInputEl = document.getElementById("registerPasswordRepeatInput");
  const authProfileNameEl = document.getElementById("authProfileName");
  const authProfileLoginEl = document.getElementById("authProfileLogin");
  const authProfileSyncEl = document.getElementById("authProfileSync");

  const aiChatButton = document.getElementById("headerAiButton");
  const aiChatModal = document.getElementById("aiChatModal");
  const aiChatCloseButton = document.getElementById("aiChatCloseButton");
  const aiChatMessagesEl = document.getElementById("aiChatMessages");
  const aiChatForm = document.getElementById("aiChatForm");
  const aiChatInput = document.getElementById("aiChatInput");
  const aiChatSendReasoning = document.getElementById("aiChatSendReasoning");
  const aiChatSendFast = document.getElementById("aiChatSendFast");
  const aiImageButton = document.getElementById("aiImageButton");
  const aiImageInput = document.getElementById("aiImageInput");
  const aiImagePreview = document.getElementById("aiImagePreview");
  const aiChatPromptChoice = document.getElementById("aiChatPromptChoice");
  const aiChatPromptChoiceLabel = document.getElementById("aiChatPromptChoiceLabel");
  const aiChatGoalSelect = document.getElementById("aiChatGoalSelect");
  const aiChatLoanSelect = document.getElementById("aiChatLoanSelect");
  const aiChatPromptChoiceSend = document.getElementById("aiChatPromptChoiceSend");

  const savingsWithdrawOpenButton = document.getElementById("savingsWithdrawOpenButton");
  const savingsWithdrawModal = document.getElementById("savingsWithdrawModal");
  const savingsWithdrawCloseButton = document.getElementById("savingsWithdrawCloseButton");
  const savingsWithdrawCancelButton = document.getElementById("savingsWithdrawCancelButton");
  const savingsWithdrawForm = document.getElementById("savingsWithdrawForm");
  const savingsWithdrawAmountInput = document.getElementById("savingsWithdrawAmount");
  const savingsWithdrawNoteInput = document.getElementById("savingsWithdrawNote");

  let state = loadState();
  let editingTransactionId = null;
  let editingPresetId = null;
  let lastBaseTodayRest = 0;
  let aiChatHistory = [];
  let aiChatBusy = false;
  let aiDailyRecommendationRequestDate = null;
  let aiDailyRecommendationPending = false;
  let aiPendingImages = [];

  function countAllTransactions(st) {
    if (!st || !st.months) return 0;
    return Object.values(st.months).reduce((sum, m) => sum + (m.transactions ? m.transactions.length : 0), 0);
  }

  function applyStateAndRender(newState) {
    localStorage.setItem(BASE_STORAGE_KEY, JSON.stringify(newState));
    state = loadState();
    renderCategoryOptions();
    renderPresetCategoryOptions();
    ensurePresetsForMonth(monthSelect.value);
    ensureIncomePresetsForMonth(monthSelect.value);
    applyPanelVisibilityFromState();
    applyInitialTabFromState();
    render();
  }

  function updateSyncLabel() {
    if (!syncLabelValueEl) return;
    const ts = state && state.ui && state.ui.lastSyncedAt;
    if (!ts) {
      syncLabelValueEl.textContent = "—";
      return;
    }
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) {
      syncLabelValueEl.textContent = "—";
      return;
    }
    const dateStr = d.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const timeStr = d.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    syncLabelValueEl.textContent = `${dateStr}, ${timeStr}`;
    if (authProfileSyncEl) {
      authProfileSyncEl.textContent = syncLabelValueEl.textContent;
    }
  }

  function openAuthModal() {
    if (!authModalEl) return;
    authModalEl.classList.remove("hidden");
    authModalEl.classList.add("flex");
    if (authErrorEl) authErrorEl.textContent = "";
  }

  function closeAuthModal() {
    if (!authModalEl) return;
    authModalEl.classList.add("hidden");
    authModalEl.classList.remove("flex");
  }

  function updateAuthViews() {
    const loggedIn = !!currentUserLogin;

    if (accountLoginEl) {
      accountLoginEl.textContent = currentUserName || currentUserLogin || "гость";
    }

    if (!authLoginViewEl || !authRegisterViewEl || !authProfileViewEl) return;

    if (!loggedIn) {
      authProfileViewEl.classList.add("hidden");
      if (authMode === "register") {
        authLoginViewEl.classList.add("hidden");
        authRegisterViewEl.classList.remove("hidden");
        if (authDescriptionEl) {
          authDescriptionEl.textContent = "Создайте новый аккаунт, чтобы хранить историю отдельно.";
        }
      } else {
        authLoginViewEl.classList.remove("hidden");
        authRegisterViewEl.classList.add("hidden");
        if (authDescriptionEl) {
          authDescriptionEl.textContent = "Войдите в существующий аккаунт или создайте новый, чтобы хранить историю отдельно.";
        }
      }
    } else {
      authLoginViewEl.classList.add("hidden");
      authRegisterViewEl.classList.add("hidden");
      authProfileViewEl.classList.remove("hidden");
      if (authDescriptionEl) {
        authDescriptionEl.textContent = "Текущий аккаунт.";
      }
      if (authProfileNameEl) {
        authProfileNameEl.textContent = currentUserName || "—";
      }
      if (authProfileLoginEl) {
        authProfileLoginEl.textContent = currentUserLogin || "—";
      }
      updateSyncLabel();
    }
  }

  async function initAuthAndState() {
    try {
      const meRes = await fetch("/api/me", { credentials: "include" });
      const me = meRes.ok ? await meRes.json() : { login: null };
      const login = me && me.login ? String(me.login) : null;
      const name = me && me.name ? String(me.name) : null;

      currentUserLogin = login;
      currentUserName = name;
      if (logoutButtonEl) {
        if (login) {
          logoutButtonEl.classList.remove("hidden");
        } else {
          logoutButtonEl.classList.add("hidden");
        }
      }
      updateAuthViews();

      const serverState = login ? await loadStateFromServerAsync() : null;
      const localHasData = state && state.months && Object.keys(state.months).length > 0;
      const serverHasData =
        serverState &&
        typeof serverState === "object" &&
        serverState.months &&
        Object.keys(serverState.months).length > 0;

      if (login && serverHasData && localHasData) {
        const localCount = countAllTransactions(state);
        const serverCount = countAllTransactions(serverState);

        if (localCount !== serverCount) {
          const msg =
            `Данные на сервере и в браузере различаются.\n\n` +
            `Сервер: ${serverCount} операций (${Object.keys(serverState.months).length} мес.)\n` +
            `Браузер: ${localCount} операций (${Object.keys(state.months).length} мес.)\n\n` +
            `Нажмите ОК — использовать данные БРАУЗЕРА.\n` +
            `Нажмите Отмена — использовать данные СЕРВЕРА.`;

          if (confirm(msg)) {
            saveState(state);
            console.log("[State] Conflict: user chose LOCAL data");
          } else {
            applyStateAndRender(serverState);
            console.log("[State] Conflict: user chose SERVER data");
          }
        } else {
          applyStateAndRender(serverState);
          console.log("[State] Loaded from server (per-user)");
        }
      } else if (login && serverHasData) {
        applyStateAndRender(serverState);
        console.log("[State] Loaded from server (per-user)");
      }
    } catch {
      // игнорируем ошибки сети
    } finally {
      updateSyncLabel();
    }
  }

  // Запускаем инициализацию авторизации и загрузку состояния
  initAuthAndState();

  // --- AI Memory: incremental snapshot system ---
  let aiLastSnapshotObj = null;
  let aiSnapshotMsgIndex = -1;
  let aiLastDailySnapshotHash = null;

  let currentUserLogin = null;
  let currentUserName = null;
  let authMode = "login"; // "login" | "register"

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  async function performLogin(login, password) {
    if (!login || !password) return;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        if (authErrorEl) authErrorEl.textContent = data && data.error ? data.error : "Ошибка входа";
        return;
      }
      currentUserLogin = data && data.login ? String(data.login) : null;
      currentUserName = data && data.name ? String(data.name) : null;
      if (logoutButtonEl) {
        logoutButtonEl.classList.remove("hidden");
      }
      updateAuthViews();
      if (authErrorEl) authErrorEl.textContent = "";
      await reloadStateFromServer();
      closeAuthModal();
    } catch {
      if (authErrorEl) authErrorEl.textContent = "Не удалось связаться с сервером";
    }
  }

  async function performRegister(login, password) {
    const name = (registerNameInputEl && registerNameInputEl.value.trim()) || "";
    if (!login || !password) {
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "Заполните логин и пароль";
      return;
    }
    if (!name) {
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "Введите имя";
      return;
    }
    if (password.length < 6) {
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "Пароль должен быть не короче 6 символов";
      return;
    }
    const repeat = (registerPasswordRepeatInputEl && registerPasswordRepeatInputEl.value.trim()) || "";
    if (repeat !== password) {
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "Пароли не совпадают";
      return;
    }
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password, name }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        if (authRegisterErrorEl) {
          authRegisterErrorEl.textContent = data && data.error ? data.error : "Ошибка регистрации";
        }
        return;
      }
      // После регистрации не логиним автоматически, просто предлагаем войти.
      authMode = "login";
      if (loginInputEl) loginInputEl.value = login;
      if (passwordInputEl) passwordInputEl.value = "";
      if (registerPasswordInputEl) registerPasswordInputEl.value = "";
      if (registerPasswordRepeatInputEl) registerPasswordRepeatInputEl.value = "";
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "";
      if (authErrorEl) authErrorEl.textContent = "Аккаунт создан. Введите пароль и войдите.";
      updateAuthViews();
    } catch {
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "Не удалось связаться с сервером";
    }
  }

  if (openAuthModalButtonEl) {
    openAuthModalButtonEl.addEventListener("click", () => {
      const loggedIn = !!currentUserLogin;
      authMode = loggedIn ? "profile" : "login";
      openAuthModal();
      updateAuthViews();
    });
  }

  if (authModalCloseButtonEl) {
    authModalCloseButtonEl.addEventListener("click", () => {
      closeAuthModal();
    });
  }

  if (loginFormEl) {
    // предотвратить submit по Enter
    loginFormEl.addEventListener("submit", (e) => e.preventDefault());
  }

  if (loginButton) {
    loginButton.addEventListener("click", () => {
      const login = (loginInputEl && loginInputEl.value.trim()) || "";
      const password = (passwordInputEl && passwordInputEl.value.trim()) || "";
      performLogin(login, password);
    });
  }

  if (goToRegisterButtonEl) {
    goToRegisterButtonEl.addEventListener("click", () => {
      authMode = "register";
      if (authErrorEl) authErrorEl.textContent = "";
      updateAuthViews();
    });
  }

  if (goToLoginButtonEl) {
    goToLoginButtonEl.addEventListener("click", () => {
      authMode = "login";
      if (authRegisterErrorEl) authRegisterErrorEl.textContent = "";
      updateAuthViews();
    });
  }

  if (registerSubmitButtonEl) {
    registerSubmitButtonEl.addEventListener("click", () => {
      const login = (registerLoginInputEl && registerLoginInputEl.value.trim()) || "";
      const password = (registerPasswordInputEl && registerPasswordInputEl.value.trim()) || "";
      performRegister(login, password);
    });
  }

  if (logoutButtonEl) {
    logoutButtonEl.addEventListener("click", async () => {
      try {
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      } catch {
        // ignore
      }
      currentUserLogin = null;
      currentUserName = null;
      if (logoutButtonEl) {
        logoutButtonEl.classList.add("hidden");
      }
      updateAuthViews();
      if (state && state.ui) {
        state.ui.lastSyncedAt = null;
      }
      updateSyncLabel();
      closeAuthModal();
    });
  }

  function txKey(t) {
    return `${t.date || ""}|${t.type || ""}|${t.amount || 0}|${t.category || ""}|${t.title || ""}`;
  }

  function computeSnapshotDiff(prevObj, currObj) {
    if (!prevObj || !currObj) return null;
    const diff = {};

    if (JSON.stringify(prevObj.summary) !== JSON.stringify(currObj.summary)) {
      diff.summary = currObj.summary;
    }

    const prevKeys = new Set((prevObj.lastTransactions || []).map(txKey));
    const currKeys = new Set((currObj.lastTransactions || []).map(txKey));
    const added = (currObj.lastTransactions || []).filter((t) => !prevKeys.has(txKey(t)));
    const removed = (prevObj.lastTransactions || []).filter((t) => !currKeys.has(txKey(t)));
    if (added.length > 0) diff.addedTransactions = added;
    if (removed.length > 0) diff.removedTransactions = removed.map((t) => ({ date: t.date, amount: t.amount, category: t.category, title: t.title }));

    if (JSON.stringify(prevObj.upcomingPlanned) !== JSON.stringify(currObj.upcomingPlanned)) {
      diff.upcomingPlanned = currObj.upcomingPlanned;
    }
    if (JSON.stringify(prevObj.plannedExpensesCurrentMonth) !== JSON.stringify(currObj.plannedExpensesCurrentMonth)) {
      diff.plannedExpensesCurrentMonth = currObj.plannedExpensesCurrentMonth;
    }
    if (JSON.stringify(prevObj.plannedIncomesCurrentMonth) !== JSON.stringify(currObj.plannedIncomesCurrentMonth)) {
      diff.plannedIncomesCurrentMonth = currObj.plannedIncomesCurrentMonth;
    }

    return Object.keys(diff).length > 0 ? diff : null;
  }

  function buildSnapshotContextMessage(snapshotStr) {
    try {
      const currObj = JSON.parse(snapshotStr);
      const dateStr = currObj.currentDate || "";
      const balance = Number(currObj.summary?.balanceToday) || 0;
      const header = "Актуальная дата: " + dateStr + ". Остаток на балансе: " + balance.toLocaleString("ru-RU") + " ₽.\n\n";
      return {
        role: "user",
        content: header + "Вот полный снимок данных приложения в формате JSON (бюджет, операции по всем месяцам, займы, цели, сбережения, шаблоны). Используй эти данные для анализа и рекомендаций:\n" + snapshotStr,
        _type: "full",
      };
    } catch {
      return {
        role: "user",
        content: "Вот актуальное состояние бюджета в формате JSON:\n" + snapshotStr,
        _type: "full",
      };
    }
  }

  function resetAiMemory() {
    aiLastSnapshotObj = null;
    aiSnapshotMsgIndex = -1;
    aiLastDailySnapshotHash = null;
  }

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
      const wrapper = document.createElement("div");
      wrapper.className =
        "inline-flex items-center gap-1 rounded-full border text-[11px] transition-colors bg-slate-900/60 border-slate-600 text-slate-200";

      const isActive = currentValue === cat;

      const labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.textContent = cat;
      labelBtn.className =
        "px-3 py-1.5 rounded-full " +
        (isActive
          ? "bg-sky-500/20 text-sky-100"
          : "hover:bg-slate-800");
      onTap(labelBtn, () => {
        transactionCategoryInput.value = cat;
        renderCategoryButtons(currentType, categories);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "×";
      deleteBtn.title = `Удалить категорию «${cat}»`;
      deleteBtn.className =
        "w-5 h-5 mr-1 flex items-center justify-center rounded-full text-[11px] text-slate-300 hover:bg-rose-600/80 hover:text-white transition-colors";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.categories) return;
        const arr = state.categories[currentType] || [];
        state.categories[currentType] = arr.filter((c) => c !== cat);
        // если удалили выбранную категорию — переключаемся на первую оставшуюся
        if (transactionCategoryInput.value === cat) {
          const next = state.categories[currentType][0] || "";
          transactionCategoryInput.value = next;
        }
        saveState(state);
        renderCategoryButtons(currentType, state.categories[currentType] || []);
      });

      wrapper.appendChild(labelBtn);
      wrapper.appendChild(deleteBtn);
      transactionCategoryButtonsContainer.appendChild(wrapper);
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

    if (expenseRepeatRow) {
      const showRepeat = type === "fixedExpense";
      expenseRepeatRow.classList.toggle("hidden", !showRepeat);
      if (!showRepeat && expenseRepeatCheckbox) {
        expenseRepeatCheckbox.checked = false;
      }
    }

    if (expenseTransferRow) {
      const showTransfer = type === "flexibleExpense" || type === "fixedExpense";
      expenseTransferRow.classList.toggle("hidden", !showTransfer);
      if (!showTransfer && expenseTransferCheckbox) {
        expenseTransferCheckbox.checked = false;
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

    // Повторяемые расходы редактируем как обычные расходы по категориям,
    // но в хранилище сохраняем их тип recurringExpense
    const type = tx.type === "recurringExpense" ? "flexibleExpense" : tx.type || "flexibleExpense";
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

  function appendAiMessage(role, content, modelLabel) {
    if (!aiChatMessagesEl) return;
    const wrapper = document.createElement("div");
    const isUser = role === "user";
    wrapper.className = "flex " + (isUser ? "justify-end" : "justify-start");

    const col = document.createElement("div");
    col.className = "max-w-[80%] flex flex-col items-" + (isUser ? "end" : "start");
    const bubble = document.createElement("div");
    bubble.className =
      "rounded-2xl px-3 py-2 text-[11px] leading-snug whitespace-pre-wrap " +
      (isUser
        ? "bg-sky-500/90 text-white"
        : "bg-sky-900/80 text-white border border-sky-500/40");
    bubble.textContent = content;
    col.appendChild(bubble);
    if (!isUser && modelLabel) {
      const label = document.createElement("div");
      label.className = "mt-0.5 text-[9px] text-slate-400";
      label.textContent = modelLabel;
      col.appendChild(label);
    }
    wrapper.appendChild(col);
    aiChatMessagesEl.appendChild(wrapper);
    aiChatMessagesEl.scrollTop = aiChatMessagesEl.scrollHeight;
  }

  function openAiChatModal() {
    if (!aiChatModal) return;
    if (typeof hideAiPromptChoice === "function") hideAiPromptChoice();
    aiChatModal.classList.remove("hidden");
    aiChatModal.classList.add("flex");
    if (aiChatInput) {
      aiChatInput.focus();
    }
  }

  function closeAiChatModal() {
    if (!aiChatModal) return;
    if (typeof hideAiPromptChoice === "function") hideAiPromptChoice();
    aiChatModal.classList.add("hidden");
    aiChatModal.classList.remove("flex");
  }

  function addTransactionFromAi(op) {
    if (!op) return false;
    const rawType = (op.type || "").trim();
    let typeVal = "flexibleExpense";
    if (rawType === "income") typeVal = "income";
    else if (rawType === "fixedExpense") typeVal = "fixedExpense";

    const amount = Number(op.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return false;
    }

    let dateStr = (op.date || "").trim();
    if (!dateStr) {
      const currentMonthKey = monthSelect.value;
      if (currentMonthKey) {
        const [year, month] = currentMonthKey.split("-");
        const today = new Date();
        const day = String(today.getDate()).padStart(2, "0");
        dateStr = `${year}-${month}-${day}`;
      } else if (currentDateInput && currentDateInput.value) {
        dateStr = currentDateInput.value;
      }
    }
    const monthKeyFromDate = getMonthKeyFromDate(dateStr);
    if (!monthKeyFromDate) {
      return false;
    }

    let category = (op.category || "").trim();
    if (!category) {
      category = typeVal === "income" ? "Доход" : "Прочие расходы";
    }

    const categories = getCategoriesForType(typeVal);
    if (!categories.includes(category)) {
      categories.push(category);
      state.categories[typeVal] = categories;
    }

    const title =
      (op.title || "").trim() || (typeVal === "income" ? "Доход (AI)" : "Расход (AI)");
    const noteBase = (op.note || "").trim();
    const note = noteBase || "Создано через AI-чат";

    const monthData = ensureMonth(state, monthKeyFromDate);
    monthData.transactions.push({
      id: generateId(),
      type: typeVal,
      category,
      title,
      amount,
      date: dateStr,
      note,
    });
    return true;
  }

  function addPresetFromAi(preset) {
    if (!preset) return false;
    const amount = Number(preset.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return false;
    }
    const title = (preset.title || "").trim() || "Повторяющийся платёж";
    let category = (preset.category || "").trim();
    if (!category) {
      category = "Повторяемый расход";
    }
    const rawType = (preset.type || "").trim();
    const isIncome = rawType === "income";
    const dayRaw = (preset.dayOfMonth || preset.day || "").toString().trim();
    let day = Number.parseInt(dayRaw || "1", 10);
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      day = 1;
    }

    if (!Array.isArray(state.fixedExpensePresets)) {
      state.fixedExpensePresets = [];
    }
    if (!Array.isArray(state.incomePresets)) {
      state.incomePresets = [];
    }

    const startMonthKey =
      preset.startMonthKey && typeof preset.startMonthKey === "string"
        ? preset.startMonthKey
        : null;

    const presetObj = {
      id: generateId(),
      title,
      category,
      amount,
      dayOfMonth: day,
      active: true,
    };
    if (startMonthKey) {
      presetObj.startMonthKey = startMonthKey;
    }

    if (isIncome) {
      state.incomePresets.push(presetObj);
    } else {
      state.fixedExpensePresets.push(presetObj);
    }
    return presetObj;
  }

  function buildAiSystemPrompt() {
    const cats = (state && state.categories) || DEFAULT_CATEGORIES;
    const incomeCats = (cats.income || DEFAULT_CATEGORIES.income || []).join(", ");
    const fixedCats = (cats.fixedExpense || DEFAULT_CATEGORIES.fixedExpense || []).join(", ");
    const flexCats = (cats.flexibleExpense || DEFAULT_CATEGORIES.flexibleExpense || []).join(", ");

    return (
      "Ты — финансовый помощник. Отвечай по-русски, простым языком. Не используй Markdown. " +
      "Не упоминай технические поля JSON — используй понятные формулировки на русском.\n\n" +
      "Тебе доступен полный снимок финансов пользователя: история операций, баланс, плановые доходы/расходы, займы, цели, сбережения, шаблоны. " +
      "В начале сообщения с данными указана актуальная дата и остаток на балансе — используй именно их.\n\n" +
      "Краткая справка по данным:\n" +
      "- balanceToday — реальные деньги на счёте сейчас\n" +
      "- balanceStartOfDay — баланс на начало дня (без сегодняшних трат)\n" +
      "- saldo — сальдо месяца (гибкий бюджет минус обычные расходы), это НЕ реальные деньги\n" +
      "- allTransactions — до 500 последних операций по всем месяцам\n" +
      "- loans — займы, goals — цели, presets — шаблоны повторяемых операций\n" +
      "- isMandatory — обязательный платёж (ипотека, коммуналка, аренда)\n\n" +
      "Отвечай на любые вопросы пользователя о его финансах, истории, тенденциях, рекомендациях. " +
      "Если пользователь просит добавить операцию или шаблон, используй доступные категории: " +
      "доходы: " + incomeCats + "; крупные расходы: " + fixedCats + "; обычные расходы: " + flexCats + ".\n\n" +
      "Если нужно создать операции или шаблоны, в конце ответа добавь строку:\n" +
      "AI_CMDS: {\"operations\":[...],\"presets\":[]}\n" +
      "operations: { type: \"income\" или \"expense\", amount: число, category: строка, title: строка, date: \"YYYY-MM-DD\" (опц.), note: строка (опц.) }\n" +
      "presets: { type: \"income\" или \"expense\", amount: число, category: строка, title: строка, dayOfMonth: 1-31 }\n" +
      "Если ничего добавлять не нужно — не пиши AI_CMDS.\n"
    );
  }

  /**
   * Детерминированный расчёт рекомендации: одни и те же данные → одни и те же числа.
   * Возвращает { dailyBefore, dailyAfter, uniform, nextIncome, horizon, ... }
   */
  function computeRecommendationData(currentDateStr) {
    if (!currentDateStr) return null;
    try {
      const obj = JSON.parse(buildAiBudgetSnapshot());
      if (!obj || !obj.summary) return null;
      const s = obj.summary;
      const balanceToday = Number(s.balanceStartOfDay) || Number(s.balanceToday) || 0;

      const incomePresetsCur = (obj.plannedIncomesCurrentMonth || []).filter(
        (i) => i.date && i.date > currentDateStr,
      );
      const firstNext = obj.firstIncomeNextMonth;

      const horizonDate = firstNext && firstNext.date
        ? firstNext.date
        : (() => {
            const [y, m] = (obj.currentMonthKey || "").split("-").map(Number);
            if (!y || !m) return currentDateStr;
            const d = getDaysInMonth(y, m - 1);
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          })();

      const allFutureIncomes = [...incomePresetsCur];
      const totalFutureIncomes = allFutureIncomes.reduce((a, i) => a + (Number(i.amount) || 0), 0);

      const allFutureExpenses = (obj.plannedExpensesUntilNextIncome || []).filter(
        (e) => e.date && e.date > currentDateStr && e.date <= horizonDate,
      );
      const totalFutureExpenses = allFutureExpenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);

      const autoSavingsOnFuture = Math.round(totalFutureIncomes * 0.15);

      const totalAvailable = balanceToday + totalFutureIncomes - totalFutureExpenses - autoSavingsOnFuture;
      const buffer = Math.round(Math.max(0, totalAvailable * 0.10));
      const spendable = Math.max(0, totalAvailable - buffer);

      const msDay = 86400000;
      const todayMs = new Date(currentDateStr).getTime();
      const horizonMs = new Date(horizonDate).getTime();
      const totalDays = Math.max(1, Math.round((horizonMs - todayMs) / msDay));
      const uniformDaily = Math.round(spendable / totalDays);

      const nextIncomeEvent = allFutureIncomes.length > 0
        ? [...allFutureIncomes].sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0]
        : null;

      let dailyBefore = uniformDaily;
      let dailyAfter = uniformDaily;
      let daysBeforeIncome = totalDays;
      let daysAfterIncome = 0;
      let nextIncomeInfo = null;

      if (nextIncomeEvent && nextIncomeEvent.date) {
        const incomeMs = new Date(nextIncomeEvent.date).getTime();
        daysBeforeIncome = Math.max(1, Math.round((incomeMs - todayMs) / msDay));
        daysAfterIncome = Math.max(0, totalDays - daysBeforeIncome);
        nextIncomeInfo = {
          date: nextIncomeEvent.date,
          amount: Number(nextIncomeEvent.amount) || 0,
          title: nextIncomeEvent.title || "",
          daysUntil: daysBeforeIncome,
        };

        const expBefore = allFutureExpenses
          .filter((e) => e.date && e.date <= nextIncomeEvent.date)
          .reduce((a, e) => a + (Number(e.amount) || 0), 0);
        const savBefore = Math.round(autoSavingsOnFuture * (daysBeforeIncome / totalDays));
        const availBefore = balanceToday - expBefore - savBefore;
        const spendableBefore = Math.max(0, availBefore * 0.9);
        dailyBefore = Math.round(spendableBefore / daysBeforeIncome);

        if (daysAfterIncome > 0) {
          const spendableAfter = Math.max(0, spendable - spendableBefore);
          dailyAfter = Math.round(spendableAfter / daysAfterIncome);

          if (dailyAfter < dailyBefore) {
            dailyBefore = uniformDaily;
            dailyAfter = uniformDaily;
          }
        } else {
          dailyAfter = dailyBefore;
        }
      }

      const status = spendable <= 0 ? "critical" : dailyBefore < 500 ? "warning" : "ok";

      const past = obj.pastMonthsSpending || [];
      let avgDailyPast = 0;
      if (past.length > 0) {
        const totalPast = past.reduce((a, m) => a + (m.total || 0), 0);
        avgDailyPast = Math.round(totalPast / (past.length * 30));
      }

      let expensesBeforeIncome = totalFutureExpenses;
      let expensesAfterIncome = 0;
      if (nextIncomeEvent && nextIncomeEvent.date) {
        expensesBeforeIncome = allFutureExpenses
          .filter((e) => e.date && e.date <= nextIncomeEvent.date)
          .reduce((a, e) => a + (Number(e.amount) || 0), 0);
        expensesAfterIncome = totalFutureExpenses - expensesBeforeIncome;
      }

      return {
        dailyBefore,
        dailyAfter,
        uniformDaily,
        nextIncome: nextIncomeInfo,
        horizonDate,
        totalDays,
        daysBeforeIncome,
        daysAfterIncome,
        balanceToday,
        totalFutureIncomes,
        totalFutureExpenses,
        expensesBeforeIncome,
        expensesAfterIncome,
        autoSavingsOnFuture,
        buffer,
        spendable,
        status,
        avgDailyPast,
      };
    } catch {
      return null;
    }
  }

  async function requestAiDailyRecommendation(currentDateStr, mode) {
    if (!currentDateStr) return null;

    const rec = computeRecommendationData(currentDateStr);
    if (!rec) return null;
    const useReasoning = mode === "reasoning";
    const model = useReasoning ? "deepseek-reasoner" : "deepseek-chat";

    const data_json = JSON.stringify({
      date: currentDateStr,
      balance: rec.balanceToday,
      horizon: rec.horizonDate,
      days_before_income: rec.daysBeforeIncome,
      days_after_income: rec.daysAfterIncome,
      expenses_before_income: rec.expensesBeforeIncome,
      expenses_after_income: rec.expensesAfterIncome,
      future_incomes: rec.totalFutureIncomes,
      auto_savings: rec.autoSavingsOnFuture,
      avg_daily_past: rec.avgDailyPast,
      next_income: rec.nextIncome ? { title: rec.nextIncome.title, date: rec.nextIncome.date, amount: rec.nextIncome.amount } : null,
    });

    const prompt =
      "Рассчитай дневной лимит трат. Данные:\n" + data_json + "\n\n" +
      "Правила:\n" +
      "1. daily_before = (balance - expenses_before_income) × 0.9 ÷ days_before_income. Это свободные деньги до ближайшего дохода.\n" +
      "2. daily_after = (balance + future_incomes - expenses_before_income - expenses_after_income - auto_savings) × 0.9 ÷ (days_before_income + days_after_income).\n" +
      "3. Если daily_after < daily_before → daily_before = daily_after.\n" +
      "4. Если нет дохода → daily_before = daily_after.\n" +
      "5. daily_before и daily_after — целые неотрицательные числа.\n\n" +
      "В reason пиши только простым языком для пользователя: баланс, доходы, расходы, совет. Запрещено упоминать технические названия полей.\n\n" +
      "Ответ — ТОЛЬКО JSON:\n" +
      "{\"daily_before\":N,\"daily_after\":N,\"next_income_title\":\"...\",\"next_income_date\":\"YYYY-MM-DD\",\"status\":\"ok|warning|critical\",\"reason\":\"2-3 предложения на русском\",\"optimization_tips\":[\"совет1\",\"совет2\"]}";

    try {
      const resp = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, model }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const errMsg = (data && data.error && (typeof data.error === "string" ? data.error : data.error.message || data.error.error)) || "Ошибка AI";
        state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
        if (!state.ui.aiDailyErrors || typeof state.ui.aiDailyErrors !== "object") state.ui.aiDailyErrors = {};
        state.ui.aiDailyErrors[currentDateStr] = { message: errMsg, at: Date.now() };
        saveState(state);
        return null;
      }

      let jsonStr = (data && data.text && String(data.text)) || "";
      jsonStr = jsonStr.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      let parsed = null;
      const si = jsonStr.indexOf("{");
      const ei = jsonStr.lastIndexOf("}");
      if (si !== -1 && ei > si) {
        try { parsed = JSON.parse(jsonStr.slice(si, ei + 1)); } catch { parsed = null; }
      }

      if (!parsed || typeof parsed !== "object") {
        state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
        if (!state.ui.aiDailyErrors || typeof state.ui.aiDailyErrors !== "object") state.ui.aiDailyErrors = {};
        state.ui.aiDailyErrors[currentDateStr] = { message: "AI вернул не JSON. Попробуйте ещё раз.", at: Date.now() };
        saveState(state);
        return null;
      }

      let dailyBefore = Math.max(0, Math.round(Number(parsed.daily_before ?? parsed.dailyBefore) || 0));
      let dailyAfter = Math.max(0, Math.round(Number(parsed.daily_after ?? parsed.dailyAfter) || 0));

      if (rec && rec.balanceToday > 0 && dailyBefore > rec.balanceToday) {
        dailyBefore = Math.round(rec.balanceToday * 0.9 / Math.max(1, rec.daysBeforeIncome));
      }
      if (dailyAfter > dailyBefore && rec && rec.daysAfterIncome > 0) {
        // после дохода может быть больше — это ок
      } else if (dailyAfter > dailyBefore) {
        dailyAfter = dailyBefore;
      }

      const status = (parsed.status === "warning" || parsed.status === "critical") ? parsed.status : "ok";
      let reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "";
      reason = reason
        .replace(/\s*[^.]*max_daily_before[^.]*\.?/gi, " ")
        .replace(/\s*[^.]*нулевой лимит[^.]*\.?/gi, " ")
        .replace(/\s*[^.]*установлен нулевой[^.]*\.?/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      let optimizationTips = parsed.optimization_tips ?? parsed.optimizationTips;
      if (Array.isArray(optimizationTips)) {
        optimizationTips = optimizationTips.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
      } else { optimizationTips = []; }

      const nextIncomeTitle = parsed.next_income_title || parsed.nextIncomeTitle || (rec && rec.nextIncome ? rec.nextIncome.title : "") || "";
      const nextIncomeDate = parsed.next_income_date || parsed.nextIncomeDate || (rec && rec.nextIncome ? rec.nextIncome.date : "") || "";

      const usedModel = (data && data.model) || "";
      const usedProvider = (data && data.provider) || "deepseek";
      const isReasoning = usedModel.includes("deepseek-r1") || usedModel.includes("deepseek-reasoner");

      const result = {
        value: dailyBefore,
        dailyBefore,
        dailyAfter,
        status,
        reason,
        optimizationTips,
        updatedAt: Date.now(),
        nextIncome: nextIncomeDate ? { title: nextIncomeTitle, date: nextIncomeDate } : null,
        source: "ai",
        model: usedModel,
        provider: usedProvider,
        isReasoning,
      };

      state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      if (!state.ui.aiDailyRecommendations || typeof state.ui.aiDailyRecommendations !== "object") state.ui.aiDailyRecommendations = {};
      state.ui.aiDailyRecommendations[currentDateStr] = { ...result };
      if (state.ui.aiDailyErrors && state.ui.aiDailyErrors[currentDateStr]) delete state.ui.aiDailyErrors[currentDateStr];
      saveState(state);
      return result;
    } catch (err) {
      console.error("AI daily recommendation failed", err);
      state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      if (!state.ui.aiDailyErrors || typeof state.ui.aiDailyErrors !== "object") state.ui.aiDailyErrors = {};
      state.ui.aiDailyErrors[currentDateStr] = { message: "Ошибка сети или сервера", at: Date.now() };
      saveState(state);
      return null;
    }
  }

  function buildAiBudgetSnapshot() {
    try {
      const months = (state && state.months) || {};
      const categories = (state && state.categories) || DEFAULT_CATEGORIES;

      const currentMonthKey = monthSelect ? monthSelect.value : null;
      const currentDateStr = currentDateInput ? currentDateInput.value : null;
      const periodStartStr = periodStartInput ? periodStartInput.value : null;
      const periodEndStr = periodEndInput ? periodEndInput.value : null;
      const monthData =
        currentMonthKey && months[currentMonthKey] && Array.isArray(months[currentMonthKey].transactions)
          ? months[currentMonthKey]
          : { transactions: [] };
      const txs = Array.isArray(monthData.transactions) ? monthData.transactions : [];

      let totalIncome = 0;
      let totalExpenses = 0;
      const byCategory = {};
      const lastTransactions = [];
      const upcomingPlanned = [];

      const sortedTxs = [...txs].sort((a, b) => {
        const da = a.date || "";
        const db = b.date || "";
        if (da === db) return 0;
        return da < db ? -1 : 1;
      });

      for (const tx of sortedTxs) {
        if (!tx) continue;
        const type = tx.type || "flexibleExpense";
        const amount = Number(tx.amount) || 0;
        if (!Number.isFinite(amount) || amount === 0) continue;
        const cat =
          (tx.category && String(tx.category)) ||
          (type === "income" ? "Доход" : "Расход");

        if (type === "income") {
          totalIncome += amount;
        } else if (
          type === "fixedExpense" ||
          type === "flexibleExpense" ||
          type === "recurringExpense" ||
          type === "savingTransfer"
        ) {
          totalExpenses += amount;
        }

        if (!byCategory[cat]) byCategory[cat] = 0;
        if (type === "income") {
          byCategory[cat] += amount;
        } else {
          byCategory[cat] -= amount;
        }

        const simplified = {
          type,
          category: cat,
          title: tx.title || "",
          amount,
          date: tx.date || null,
        };

        lastTransactions.push(simplified);

        if (currentDateStr && tx.date && tx.date > currentDateStr) {
          upcomingPlanned.push(simplified);
        }
      }

      // Полная история операций по всем месяцам (для полного снимка в AI)
      const allMonthsTxs = [];
      for (const mk of Object.keys(months || {}).sort()) {
        const m = months[mk];
        if (!m || !Array.isArray(m.transactions)) continue;
        for (const tx of m.transactions) {
          if (!tx) continue;
          const amount = Number(tx.amount) || 0;
          if (!Number.isFinite(amount) || amount === 0) continue;
          allMonthsTxs.push({
            monthKey: mk,
            type: tx.type || "flexibleExpense",
            category: tx.category || "",
            title: tx.title || "",
            amount,
            date: tx.date || null,
          });
        }
      }
      allMonthsTxs.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const MAX_ALL_TXS = 500;
      const allTransactions = allMonthsTxs.slice(-MAX_ALL_TXS);

      // Сумма сбережений (все savingTransfer по всем месяцам)
      let savingsTotal = 0;
      for (const mk of Object.keys(months || {})) {
        const m = months[mk];
        if (!m || !Array.isArray(m.transactions)) continue;
        for (const tx of m.transactions) {
          if (tx && tx.type === "savingTransfer" && Number.isFinite(Number(tx.amount))) savingsTotal += Number(tx.amount);
        }
      }

      const MAX_HISTORY = 30;
      const MAX_UPCOMING = 20;
      const recent = lastTransactions.slice(-MAX_HISTORY);
      const upcoming = upcomingPlanned.slice(0, MAX_UPCOMING);

      const fixedExpensePresets = Array.isArray(state?.fixedExpensePresets)
        ? state.fixedExpensePresets
        : [];
      const incomePresets = Array.isArray(state?.incomePresets)
        ? state.incomePresets
        : [];

      const presetSummary = {
        fixed: (fixedExpensePresets || []).map((p) => ({
          title: p.title || "",
          category: p.category || "",
          amount: Number(p.amount) || 0,
          dayOfMonth: p.dayOfMonth || 1,
          active: p.active !== false,
        })),
        income: (incomePresets || []).map((p) => ({
          title: p.title || "",
          category: p.category || "",
          amount: Number(p.amount) || 0,
          dayOfMonth: p.dayOfMonth || 1,
          active: p.active !== false,
        })),
      };

      const loans = Array.isArray(state?.loans) ? state.loans.map((l) => ({
        id: l.id,
        kind: l.kind || "borrow",
        name: l.name || "",
        amount: Number(l.amount) || 0,
        balance: Number(l.balance ?? l.amount) || 0,
        dueDate: l.dueDate || null,
        note: l.note || "",
      })) : [];
      const goals = Array.isArray(state?.goals) ? state.goals.map((g) => ({
        id: g.id,
        name: g.name || "",
        category: g.category || "",
        targetAmount: Number(g.targetAmount) || 0,
        currentAmount: Number(g.currentAmount) || 0,
        dueDate: g.dueDate || null,
        note: g.note || "",
      })) : [];

      // Берём сальдо и авто-сбережения из той же функции, что и дашборд,
      // чтобы AI видел те же цифры, что и пользователь.
      let saldo = totalIncome - totalExpenses;
      let autoSavings = 0;
      let flexibleBudget = totalIncome - totalExpenses;
      if (currentMonthKey) {
        try {
          const metrics = computeMetricsForMonth(
            currentMonthKey,
            currentDateStr,
            periodStartStr,
            periodEndStr,
          );
          if (metrics) {
            saldo = metrics.saldo;
            autoSavings = metrics.autoSavings;
            flexibleBudget = metrics.flexibleBudget;
          }
        } catch {
          // если что-то пошло не так — оставляем резервные значения
        }
      }

      let balanceToday = 0;
      let spentTodayTotal = 0;
      if (currentDateStr) {
        for (const mk of Object.keys(months || {})) {
          const m = months[mk];
          if (!m || !Array.isArray(m.transactions)) continue;
          for (const tx of m.transactions) {
            if (!tx) continue;
            const txDate = tx.date || "";
            if (!txDate || txDate > currentDateStr) continue;
            const amount = Number(tx.amount) || 0;
            if (!Number.isFinite(amount) || amount === 0) continue;
            if (tx.type === "income") {
              balanceToday += amount;
            } else if (tx.type === "balanceAdjustment") {
              balanceToday += amount;
            } else if (
              tx.type === "fixedExpense" ||
              tx.type === "recurringExpense" ||
              tx.type === "flexibleExpense" ||
              tx.type === "savingTransfer"
            ) {
              balanceToday -= amount;
              if (txDate === currentDateStr && (tx.type === "flexibleExpense" || tx.type === "savingTransfer")) {
                spentTodayTotal += amount;
              }
            }
          }
        }
      }
      const balanceStartOfDay = balanceToday + spentTodayTotal;

      // Следующий ожидаемый доход (например, аванс/зарплата)
      let nextIncome = null;
      if (currentDateStr && upcomingPlanned.length > 0) {
        const nextIncomeTx = upcomingPlanned.find((t) => t.type === "income" && t.date);
        if (nextIncomeTx && nextIncomeTx.date) {
          const today = new Date(currentDateStr);
          const incomeDate = new Date(nextIncomeTx.date);
          if (!Number.isNaN(today.getTime()) && !Number.isNaN(incomeDate.getTime())) {
            const ms = incomeDate.getTime() - today.getTime();
            const daysUntil = ms > 0 ? Math.ceil(ms / (1000 * 60 * 60 * 24)) : 0;
            nextIncome = {
              date: nextIncomeTx.date,
              amount: nextIncomeTx.amount,
              daysUntil,
              title: nextIncomeTx.title || "",
            };
          }
        }
      }

      // Запланированные доходы/расходы с датами: текущий месяц и до ближайшего дохода следующего месяца
      function getNextMonthKey(key) {
        const parts = (key || "").split("-").map(Number);
        if (parts.length < 2) return null;
        const [y, m] = parts;
        if (m === 12) return `${y + 1}-01`;
        return `${y}-${String(m + 1).padStart(2, "0")}`;
      }
      function plannedForMonth(monthKey, presetsIncome, presetsFixed) {
        const [y, monthNum] = (monthKey || "").split("-").map(Number);
        if (!y || !monthNum) return { incomes: [], expenses: [] };
        const daysIn = getDaysInMonth(y, monthNum - 1);
        const incomes = (presetsIncome || []).filter((p) => p.active).map((p) => {
          const day = Math.min(p.dayOfMonth || 1, daysIn);
          const date = `${y}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          return { date, amount: p.amount, title: p.title };
        });
        const expenses = (presetsFixed || []).filter((p) => p.active).map((p) => {
          const day = Math.min(p.dayOfMonth || 1, daysIn);
          const date = `${y}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          return { date, amount: p.amount, title: p.title, category: p.category };
        });
        return { incomes, expenses };
      }
      const plannedCurrent = plannedForMonth(currentMonthKey, presetSummary.income, presetSummary.fixed);
      const nextMonthKey = getNextMonthKey(currentMonthKey);
      const plannedNextMonth = nextMonthKey ? plannedForMonth(nextMonthKey, presetSummary.income, presetSummary.fixed) : { incomes: [], expenses: [] };
      const firstIncomeNextMonth = plannedNextMonth.incomes.length > 0
        ? plannedNextMonth.incomes.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0]
        : null;
      const MANDATORY_CATEGORIES = ["Ипотека/кредит", "Коммуналка", "Аренда"];
      function isMandatoryExpense(category) {
        const c = (category || "").trim().toLowerCase();
        return MANDATORY_CATEGORIES.some((m) => m.toLowerCase() === c);
      }
      const plannedExpensesUntilNextIncome = [
        ...plannedCurrent.expenses.filter((e) => e.date && e.date >= currentDateStr),
        ...(firstIncomeNextMonth
          ? plannedNextMonth.expenses.filter((e) => e.date && e.date <= (firstIncomeNextMonth.date || ""))
          : []),
      ]
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
        .map((e) => ({ ...e, isMandatory: isMandatoryExpense(e.category) }));
      const plannedExpensesCurrentMonthTagged = (plannedCurrent.expenses || []).map((e) => ({
        ...e,
        isMandatory: isMandatoryExpense(e.category),
      }));

      // Привычки по расходам за прошлые месяцы (последние 3 месяца)
      const monthKeys = Object.keys(months || {}).filter(Boolean).sort();
      const currentIdx = monthKeys.indexOf(currentMonthKey);
      const pastMonthsSpending = [];
      for (let i = 1; i <= 3; i++) {
        const idx = currentIdx - i;
        if (idx < 0) break;
        const mk = monthKeys[idx];
        const m = months[mk];
        if (!m || !Array.isArray(m.transactions)) continue;
        let total = 0;
        const byCat = {};
        for (const tx of m.transactions) {
          if (!tx || tx.type === "income" || tx.type === "balanceAdjustment") continue;
          const amount = Number(tx.amount) || 0;
          if (!Number.isFinite(amount)) continue;
          total += amount;
          const cat = tx.category || "Прочее";
          byCat[cat] = (byCat[cat] || 0) + amount;
        }
        pastMonthsSpending.push({ monthKey: mk, total, byCategory: byCat });
      }

      let daysInMonth = 30;
      if (currentMonthKey) {
        const [y, m] = currentMonthKey.split("-").map(Number);
        if (y && m) daysInMonth = getDaysInMonth(y, m - 1);
      }
      const monthlyAverageDaily =
        daysInMonth > 0 ? Math.round((flexibleBudget || 0) / daysInMonth) : 0;

      const snapshot = {
        currentMonthKey,
        currentDate: currentDateStr,
        summaryLegend: "balanceToday = остаток на балансе (реальные деньги на счёте сейчас). saldo = сальдо месяца (гибкий бюджет минус обычные расходы), НЕ путать с остатком на балансе.",
        summary: {
          balanceToday,
          balanceStartOfDay,
          saldo,
          totalIncome,
          totalExpenses,
          autoSavings,
          flexibleBudget,
          monthlyAverageDaily,
          daysInMonth,
          byCategory,
          nextIncome,
        },
        plannedIncomesCurrentMonth: plannedCurrent.incomes,
        plannedExpensesCurrentMonth: plannedExpensesCurrentMonthTagged,
        firstIncomeNextMonth: firstIncomeNextMonth || null,
        plannedExpensesUntilNextIncome,
        mandatoryExpenseCategories: ["Ипотека/кредит", "Коммуналка", "Аренда"],
        pastMonthsSpending,
        savingsRules: "15% от доходов месяца (зарплата и др.) — в сбережения; с каждой покупки (кроме ипотеки/коммуналки) — 5% до 1000₽ + округление до 50₽ в сбережения.",
        lastTransactions: recent,
        upcomingPlanned: upcoming,
        presets: presetSummary,
        categories,
        savingsTotal,
        loans,
        goals,
        allTransactions,
      };

      return JSON.stringify(snapshot);
    } catch {
      return "{}";
    }
  }

  async function sendAiMessage(text, mode) {
    if (aiChatBusy) return;
    const rawText = (text || "").toString();
    const cleanText = rawText.trim();
    const hasText = cleanText.length > 0;
    const hasImages = Array.isArray(aiPendingImages) && aiPendingImages.length > 0;
    if (!hasText && !hasImages) return;
    const useReasoning = mode === "reasoning";
    const model = useReasoning ? "deepseek-reasoner" : "deepseek-chat";

    appendAiMessage("user", cleanText || "[изображение]");
    aiChatHistory.push({ role: "user", content: cleanText || "[image-only message]" });

    aiChatBusy = true;
    if (aiChatSendReasoning) {
      aiChatSendReasoning.disabled = true;
      aiChatSendReasoning.textContent = useReasoning ? "Думает…" : "R";
    }
    if (aiChatSendFast) {
      aiChatSendFast.disabled = true;
      aiChatSendFast.textContent = useReasoning ? "Быстро" : "Думает…";
    }

    const systemPrompt = buildAiSystemPrompt();

    const historyForApi = aiChatHistory.slice(-10);
    const budgetSnapshot = buildAiBudgetSnapshot();
    const snapshotMsg = buildSnapshotContextMessage(budgetSnapshot);

    const userContentParts = [];
    if (hasText) {
      userContentParts.push({ type: "text", text: cleanText });
    }
    if (Array.isArray(aiPendingImages) && aiPendingImages.length > 0) {
      for (const url of aiPendingImages) {
        userContentParts.push({
          type: "image_url",
          imageUrl: { url },
        });
      }
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: snapshotMsg.role, content: snapshotMsg.content },
      ...historyForApi,
      {
        role: "user",
        content: userContentParts.length > 0 ? userContentParts : cleanText,
      },
    ];

    try {
      const resp = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages, model }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        let errMsg = "Ошибка AI";
        if (data && data.error) {
          if (typeof data.error === "string") {
            errMsg = data.error;
          } else if (data.error.message) {
            errMsg = data.error.message;
          } else {
            try {
              errMsg = JSON.stringify(data.error);
            } catch {
              errMsg = String(data.error);
            }
          }
        }
        appendAiMessage("assistant", `Ошибка AI: ${errMsg}`);
        aiChatHistory.push({ role: "assistant", content: `Ошибка AI: ${errMsg}` });
        return;
      }

      const textResponse = (data && data.text) || "";
      let visibleText = textResponse;
      const aiCmdsIndex = textResponse.indexOf("AI_CMDS:");
      if (aiCmdsIndex !== -1) {
        visibleText = textResponse.slice(0, aiCmdsIndex).trim();
      }
      const usedModel = (data && data.model) || model;
      const modelLabel = String(usedModel).includes("reasoner") ? "— Reasoning (R)" : "— Быстрый";
      appendAiMessage("assistant", visibleText || "[AI не вернул текст ответа]", modelLabel);
      aiChatHistory.push({ role: "assistant", content: textResponse });

      let createdOps = false;
      let createdPresets = false;
      const match = textResponse.match(/AI_CMDS:\s*({[\s\S]*})/);
      if (match && match[1]) {
        try {
          const jsonStr = match[1].replace(/```/g, "").trim();
          const cmdObj = JSON.parse(jsonStr);
          if (cmdObj) {
            if (Array.isArray(cmdObj.operations)) {
              for (const rawOp of cmdObj.operations) {
                const op = rawOp || {};
                if (addTransactionFromAi(op)) {
                  createdOps = true;
                }
              }
            }
            if (Array.isArray(cmdObj.presets)) {
              for (const rawPreset of cmdObj.presets) {
                const p = rawPreset || {};
                if (addPresetFromAi(p)) {
                  createdPresets = true;
                }
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse AI_CMDS JSON", e);
        }
      }
      if (createdOps || createdPresets) {
        saveStateToServer();
        if (createdPresets) {
          ensurePresetsForMonth(monthSelect.value);
          ensureIncomePresetsForMonth(monthSelect.value);
        }
        render();
      }
    } catch (err) {
      console.error("AI request failed", err);
      appendAiMessage(
        "assistant",
        "Не удалось связаться с AI. Попробуйте ещё раз позже.",
      );
      aiChatHistory.push({
        role: "assistant",
        content: "Не удалось связаться с AI. Попробуйте ещё раз позже.",
      });
    } finally {
      // очищаем прикрепленные изображения после отправки
      aiPendingImages = [];
      if (aiImagePreview) {
        aiImagePreview.innerHTML = "";
      }
      aiChatBusy = false;
      if (aiChatSendReasoning) {
        aiChatSendReasoning.disabled = false;
        aiChatSendReasoning.textContent = "Reasoning (R)";
      }
      if (aiChatSendFast) {
        aiChatSendFast.disabled = false;
        aiChatSendFast.textContent = "Быстрый";
      }
    }
  }

  function startEditTransaction(tx) {
    if (!tx) return;
    openEditTransactionModal(tx);
  }

  function handleEditTransactionSubmit(event) {
    event.preventDefault();
    if (!editingTransactionId) return;

    const typeVal = (editTransactionTypeInput && editTransactionTypeInput.value) || "flexibleExpense";
    const category = (editTransactionCategorySelect?.value || "").trim();
    const title = (editTransactionTitleInput?.value || "").trim();
    const amount = parseAmountFromInput(editTransactionAmountInput?.value);
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
    const originalType = existing.type;
    const newType = originalType === "recurringExpense" ? "recurringExpense" : typeVal;

    if (targetMonthKey !== foundMonthKey) {
      // Переносим операцию в другой месяц
      state.months[foundMonthKey].transactions = state.months[foundMonthKey].transactions.filter(
        (t) => t.id !== editingTransactionId,
      );
      ensureMonth(state, targetMonthKey);
      state.months[targetMonthKey].transactions.push({
        id: existing.id,
        type: newType,
        category,
        title,
        amount,
        date,
        note,
        presetId: existing.presetId,
      });
    } else {
      // Обновляем на месте
      existing.type = newType;
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
    const allowed = ["dashboard", "history", "presets", "goals", "loans", "analytics"];
    if (!allowed.includes(tab)) tab = "dashboard";

    if (saveToState) {
      state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      state.ui.currentTab = tab;
      saveState(state);
    }

    const isDashboard = tab === "dashboard";
    const isHistory = tab === "history";
    const isPresets = tab === "presets";
    const isGoals = tab === "goals";
    const isLoans = tab === "loans";
    const isAnalytics = tab === "analytics";

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
    if (tabGoalsButton) {
      tabGoalsButton.classList.toggle("bg-slate-800/80", isGoals);
      tabGoalsButton.classList.toggle("border-slate-500/60", isGoals);
      tabGoalsButton.classList.toggle("text-slate-50", isGoals);
      tabGoalsButton.classList.toggle("border-transparent", !isGoals);
      tabGoalsButton.classList.toggle("text-slate-400", !isGoals);
    }
    if (tabLoansButton) {
      tabLoansButton.classList.toggle("bg-slate-800/80", isLoans);
      tabLoansButton.classList.toggle("border-slate-500/60", isLoans);
      tabLoansButton.classList.toggle("text-slate-50", isLoans);
      tabLoansButton.classList.toggle("border-transparent", !isLoans);
      tabLoansButton.classList.toggle("text-slate-400", !isLoans);
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
    if (goalsSection) {
      goalsSection.classList.toggle("hidden", !isGoals);
    }
    if (loansSection) {
      loansSection.classList.toggle("hidden", !isLoans);
    }
    // форма добавления операции теперь всегда открывается как модалка по кнопке "+",
    // поэтому её видимость не зависит от табов
    if (analyticsSection) {
      analyticsSection.classList.toggle("hidden", !isAnalytics);
    }
    if (todaySummaryRow) {
      todaySummaryRow.classList.remove("hidden");
    }
  }

  function focusTransactionForm() {
    if (!transactionForm) return;
    if (addOperationModal && !addOperationModal.classList.contains("hidden")) {
      // если открыта модалка, просто фокусируем поле без скролла всей страницы
      if (transactionTitleInput) {
        transactionTitleInput.focus();
      } else if (transactionAmountInput) {
        transactionAmountInput.focus();
      }
    } else {
    transactionForm.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      if (transactionTitleInput) {
        transactionTitleInput.focus();
      } else if (transactionAmountInput) {
        transactionAmountInput.focus();
      }
    }, 200);
    }
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
    const stored = ui.currentTab || "dashboard";
    const currentTab = stored === "operations" ? "dashboard" : stored;
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

  async function reloadStateFromServer() {
    const serverState = await loadStateFromServerAsync();
    if (serverState && typeof serverState === "object" && serverState.months) {
      applyStateAndRender(serverState);
      updateSyncLabel();
    }
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
    let savingTransfersToDate = 0;
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
          savingTransfersToDate += amount;
        }
      }
    }

    // Сбережения считаем как 15% от всех доходов месяца (включая планируемые),
    // а не только по фактическим переводам savingTransfer.
    const autoSavings = Math.round(totalIncome * 0.15);
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
      totalIncomeToDate,
      totalFixedToDate,
      flexibleSpentSoFar,
      flexibleExpensesOnly,
      flexibleSpentToday,
      savingTransfersTotal,
      savingTransfersToDate,
      daysInMonth,
      currentDayNumber,
      warnings,
    };
  }

  function getLoansArray() {
    if (!state.loans || !Array.isArray(state.loans)) {
      state.loans = [];
    }
    return state.loans;
  }

  function getGoalsArray() {
    if (!state.goals || !Array.isArray(state.goals)) {
      state.goals = [];
    }
    return state.goals;
  }

  let loanActionLoanId = null;
  let loanActionMode = null; // "pay" | "receive"
  let editingLoanId = null;

  function openLoanActionModal(loanId, mode) {
    if (!loanActionModal) return;
    loanActionLoanId = loanId;
    loanActionMode = mode;

    const loans = getLoansArray();
    const loan = loans.find((l) => l && l.id === loanId);
    if (!loan) return;

    const balance = Number(loan.balance ?? loan.amount ?? 0) || 0;
    const name = loan.name || "";

    if (loanActionTitleEl) {
      loanActionTitleEl.textContent =
        mode === "receive" ? `Получить по займу: ${name || "Без имени"}` : `Погасить займ: ${name || "Без имени"}`;
    }
    if (loanActionAmountInput) {
      loanActionAmountInput.value = balance > 0 ? String(Math.round(balance)) : "";
      loanActionAmountInput.focus();
    }
    if (loanActionDateInput && currentDateInput && currentDateInput.value) {
      loanActionDateInput.value = currentDateInput.value;
    }
    if (loanActionNoteInput) {
      loanActionNoteInput.value = "";
    }
    if (loanActionSubmitButton) {
      loanActionSubmitButton.textContent = mode === "receive" ? "Получил" : "Погасить";
    }

    loanActionModal.classList.remove("hidden");
    loanActionModal.classList.add("flex");
  }

  function closeLoanActionModal() {
    if (!loanActionModal) return;
    loanActionModal.classList.add("hidden");
    loanActionModal.classList.remove("flex");
    loanActionLoanId = null;
    loanActionMode = null;
    if (loanActionAmountInput) loanActionAmountInput.value = "";
    if (loanActionNoteInput) loanActionNoteInput.value = "";
  }

  function openLoanEditModal(loanId) {
    if (!loanEditModal) return;
    const loans = getLoansArray();
    const loan = loans.find((l) => l && l.id === loanId);
    if (!loan) return;

    editingLoanId = loanId;
    if (loanEditKindInput) loanEditKindInput.value = loan.kind || "borrow";
    if (loanEditNameInput) loanEditNameInput.value = loan.name || "";
    if (loanEditAmountInput) loanEditAmountInput.value = String(Number(loan.amount ?? 0) || 0);
    if (loanEditBalanceInput) loanEditBalanceInput.value = String(Number(loan.balance ?? loan.amount ?? 0) || 0);
    if (loanEditDueDateInput) loanEditDueDateInput.value = loan.dueDate || "";
    if (loanEditNoteInput) loanEditNoteInput.value = loan.note || "";

    loanEditModal.classList.remove("hidden");
    loanEditModal.classList.add("flex");
    if (loanEditNameInput) loanEditNameInput.focus();
  }

  function closeLoanEditModal() {
    if (!loanEditModal) return;
    loanEditModal.classList.add("hidden");
    loanEditModal.classList.remove("flex");
    editingLoanId = null;
  }

  function renderLoans() {
    if (!loansListEl || !loansEmptyStateEl) return;
    const loans = getLoansArray();
    if (!loans.length) {
      loansEmptyStateEl.classList.remove("hidden");
      loansListEl.classList.add("hidden");
      loansListEl.innerHTML = "";
      return;
    }
    loansEmptyStateEl.classList.remove("hidden");
    loansEmptyStateEl.classList.add("hidden");
    loansListEl.classList.remove("hidden");
    loansListEl.innerHTML = "";

    const todayStr = currentDateInput && currentDateInput.value ? currentDateInput.value : null;

    const sorted = [...loans].sort((a, b) => {
      const d1 = a.dueDate || "";
      const d2 = b.dueDate || "";
      if (d1 === d2) return 0;
      return d1 < d2 ? -1 : 1;
    });

    for (const loan of sorted) {
      const row = document.createElement("div");
      row.className =
        "flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-slate-700/70 bg-slate-900/60 px-3 py-2";

      const kind =
        loan.kind === "lend" ? "Мне должны" : loan.kind === "credit" ? "Кредит" : "Я должен";
      const name = loan.name || "";
      const balance = Number(loan.balance ?? loan.amount ?? 0) || 0;
      const due = loan.dueDate || "";

      const left = document.createElement("div");
      left.className = "min-w-0";
      const titleEl = document.createElement("div");
      titleEl.className = "text-[11px] font-semibold text-slate-100 truncate";
      titleEl.textContent = `${kind}: ${name || "Без имени"}`;

      const metaEl = document.createElement("div");
      metaEl.className = "text-[10px] text-slate-400";
      const parts = [`Остаток: ${formatCurrency(balance)}`];
      if (due) parts.push(`до ${due}`);
      metaEl.textContent = parts.join(" · ");

      left.appendChild(titleEl);
      left.appendChild(metaEl);

      const right = document.createElement("div");
      right.className = "flex items-center gap-2 flex-shrink-0";

      const hasPositiveBalance = balance > 0;

      // Кнопка редактирования
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className =
        "inline-flex items-center justify-center w-7 h-7 rounded-full border border-slate-600/80 text-slate-200 hover:bg-slate-800 transition-colors text-[11px]";
      editBtn.textContent = "✎";
      editBtn.title = "Редактировать";
      editBtn.addEventListener("click", () => openLoanEditModal(loan.id));
      right.appendChild(editBtn);

      // Кнопка удаления
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className =
        "inline-flex items-center justify-center w-7 h-7 rounded-full border border-rose-500/80 text-rose-300 hover:bg-rose-600/20 hover:text-rose-100 transition-colors text-[11px]";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Удалить займ";
      deleteBtn.addEventListener("click", () => {
        const confirmDelete = window.confirm("Удалить этот займ? Операции в истории затронуты не будут.");
        if (!confirmDelete) return;
        const loansArr = getLoansArray();
        const idx = loansArr.findIndex((l) => l && l.id === loan.id);
        if (idx !== -1) {
          loansArr.splice(idx, 1);
          saveState(state);
          saveStateToServer();
          renderLoans();
        }
      });
      right.appendChild(deleteBtn);

      if (loan.kind === "borrow" || loan.kind === "credit") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "px-3 py-1.5 rounded-lg bg-rose-500 text-[10px] font-semibold text-rose-50 hover:bg-rose-400 disabled:opacity-60 disabled:cursor-not-allowed";
        btn.textContent = "Погасить";
        btn.disabled = !hasPositiveBalance;
        btn.addEventListener("click", () => openLoanActionModal(loan.id, "pay"));
        right.appendChild(btn);
      } else if (loan.kind === "lend") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "px-3 py-1.5 rounded-lg bg-emerald-500 text-[10px] font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed";
        btn.textContent = "Получил";
        btn.disabled = !hasPositiveBalance;
        btn.addEventListener("click", () => openLoanActionModal(loan.id, "receive"));
        right.appendChild(btn);
      }

      row.appendChild(left);
      row.appendChild(right);
      loansListEl.appendChild(row);
    }
  }

  let editingGoalId = null;
  let goalActionGoalId = null;
  let goalActionMode = null; // "deposit" | "withdraw"

  function openGoalEditModal(goalId) {
    if (!goalEditModal) return;
    const goals = getGoalsArray();
    const goal = goals.find((g) => g && g.id === goalId);
    if (!goal) return;
    editingGoalId = goalId;

    if (goalEditNameInput) goalEditNameInput.value = goal.name || "";
    if (goalEditCategoryInput) goalEditCategoryInput.value = goal.category || "";
    if (goalEditTargetAmountInput) {
      goalEditTargetAmountInput.value =
        goal.targetAmount != null && Number.isFinite(Number(goal.targetAmount))
          ? String(goal.targetAmount)
          : "";
    }
    if (goalEditCurrentAmountDisplay) {
      const current = Number(goal.currentAmount) || 0;
      goalEditCurrentAmountDisplay.textContent = formatCurrency(current);
    }
    if (goalEditDueDateInput) goalEditDueDateInput.value = goal.dueDate || "";
    if (goalEditNoteInput) goalEditNoteInput.value = goal.note || "";

    goalEditModal.classList.remove("hidden");
    goalEditModal.classList.add("flex");
  }

  function closeGoalEditModal() {
    if (!goalEditModal) return;
    goalEditModal.classList.add("hidden");
    goalEditModal.classList.remove("flex");
    editingGoalId = null;
  }

  function openGoalActionModal(goalId, mode) {
    if (!goalActionModal) return;
    const goals = getGoalsArray();
    const goal = goals.find((g) => g && g.id === goalId);
    if (!goal) return;

    goalActionGoalId = goalId;
    goalActionMode = mode === "withdraw" ? "withdraw" : "deposit";

    const titleBase = goal.name || "Цель";
    if (goalActionTitleEl) {
      goalActionTitleEl.textContent =
        goalActionMode === "withdraw" ? `Вывод с цели: ${titleBase}` : `Взнос на цель: ${titleBase}`;
    }
    if (goalActionAmountInput) {
      goalActionAmountInput.value = "";
      goalActionAmountInput.focus();
    }
    if (goalActionDateInput) {
      if (currentDateInput && currentDateInput.value) {
        goalActionDateInput.value = currentDateInput.value;
      } else {
        goalActionDateInput.value = new Date().toISOString().slice(0, 10);
      }
    }
    if (goalActionNoteInput) {
      goalActionNoteInput.value = "";
    }
    if (goalActionSubmitButton) {
      goalActionSubmitButton.textContent = goalActionMode === "withdraw" ? "Вывести" : "Внести";
    }

    goalActionModal.classList.remove("hidden");
    goalActionModal.classList.add("flex");
  }

  function closeGoalActionModal() {
    if (!goalActionModal) return;
    goalActionModal.classList.add("hidden");
    goalActionModal.classList.remove("flex");
    goalActionGoalId = null;
    goalActionMode = null;
    if (goalActionAmountInput) goalActionAmountInput.value = "";
    if (goalActionNoteInput) goalActionNoteInput.value = "";
  }

  function renderGoals() {
    if (!goalsListEl || !goalsEmptyStateEl) return;
    const goals = getGoalsArray();
    if (!goals.length) {
      goalsEmptyStateEl.classList.remove("hidden");
      goalsListEl.classList.add("hidden");
      goalsListEl.innerHTML = "";
      return;
    }

    goalsEmptyStateEl.classList.add("hidden");
    goalsListEl.classList.remove("hidden");
    goalsListEl.innerHTML = "";

    const todayStr = currentDateInput && currentDateInput.value ? currentDateInput.value : null;

    for (const goal of goals) {
      const row = document.createElement("div");
      row.className =
        "flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-slate-700/70 bg-slate-900/60 px-3 py-2";

      const title = goal.name || "Без названия";
      const category = goal.category || "";
      const target = Number(goal.targetAmount) || 0;
      const current = Number(goal.currentAmount) || 0;
      const due = goal.dueDate || "";
      const left = Math.max(target - current, 0);

      const leftCol = document.createElement("div");
      leftCol.className = "min-w-0";

      const titleEl = document.createElement("div");
      titleEl.className = "text-[11px] font-semibold text-slate-100 truncate";
      titleEl.textContent = title;
      leftCol.appendChild(titleEl);

      const metaEl = document.createElement("div");
      metaEl.className = "text-[10px] text-slate-400";
      const parts = [];
      if (category) parts.push(category);
      parts.push(`Накоплено: ${formatCurrency(current)}`);
      if (target > 0) {
        parts.push(`Цель: ${formatCurrency(target)}`);
        parts.push(`Осталось: ${formatCurrency(left)}`);
      }
      if (due) parts.push(`до ${due}`);
      metaEl.textContent = parts.join(" · ");
      leftCol.appendChild(metaEl);

      const rightCol = document.createElement("div");
      rightCol.className = "flex items-center gap-2 flex-shrink-0";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className =
        "inline-flex items-center justify-center w-7 h-7 rounded-full border border-slate-600/80 text-slate-200 hover:bg-slate-800 transition-colors text-[11px]";
      editBtn.textContent = "✎";
      editBtn.title = "Редактировать цель";
      editBtn.addEventListener("click", () => openGoalEditModal(goal.id));
      rightCol.appendChild(editBtn);

      const depositBtn = document.createElement("button");
      depositBtn.type = "button";
      depositBtn.className =
        "px-3 py-1.5 rounded-lg bg-emerald-500 text-[10px] font-semibold text-emerald-950 hover:bg-emerald-400";
      depositBtn.textContent = "Внести";
      depositBtn.addEventListener("click", () => openGoalActionModal(goal.id, "deposit"));
      rightCol.appendChild(depositBtn);

      const withdrawBtn = document.createElement("button");
      withdrawBtn.type = "button";
      withdrawBtn.className =
        "px-3 py-1.5 rounded-lg bg-slate-700 text-[10px] font-semibold text-slate-50 hover:bg-slate-600";
      withdrawBtn.textContent = "Вывести";
      withdrawBtn.disabled = current <= 0;
      withdrawBtn.addEventListener("click", () => {
        if (Number(goal.currentAmount) <= 0) return;
        openGoalActionModal(goal.id, "withdraw");
      });
      rightCol.appendChild(withdrawBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className =
        "inline-flex items-center justify-center w-7 h-7 rounded-full border border-rose-500/80 text-rose-300 hover:bg-rose-600/20 hover:text-rose-100 transition-colors text-[11px]";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Удалить цель";
      deleteBtn.addEventListener("click", () => {
        const confirmDelete = window.confirm(
          'Удалить цель? Транзакции по цели в истории останутся.',
        );
        if (!confirmDelete) return;
        const goalsArr = getGoalsArray();
        const idx = goalsArr.findIndex((g) => g && g.id === goal.id);
        if (idx !== -1) {
          goalsArr.splice(idx, 1);
          saveState(state);
          saveStateToServer();
          render();
        }
      });
      rightCol.appendChild(deleteBtn);

      row.appendChild(leftCol);
      row.appendChild(rightCol);
      goalsListEl.appendChild(row);
    }
  }
  function render() {
    const monthKey = monthSelect ? monthSelect.value : null;
    const currentDateStr = currentDateInput ? currentDateInput.value : null;
    const periodStartStr = periodStartInput ? periodStartInput.value : null;
    const periodEndStr = periodEndInput ? periodEndInput.value : null;

    if (!monthKey) {
      totalIncomeEl.textContent = formatCurrency(0);
      if (totalIncomePlannedEl) {
        totalIncomePlannedEl.textContent = formatCurrency(0);
      }
      totalFixedExpensesEl.textContent = formatCurrency(0);
      if (totalFixedPlannedEl) {
        totalFixedPlannedEl.textContent = formatCurrency(0);
      }
      flexibleBudgetEl.textContent = formatCurrency(0);
      if (autoSavingsRealEl) {
        autoSavingsRealEl.textContent = formatCurrency(0);
      }
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
      if (todayRecommendedLabelEl) todayRecommendedLabelEl.textContent = "";
      if (todayRecommendedAfterEl) todayRecommendedAfterEl.classList.add("hidden");
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

    // отрисовка займов и целей не зависит от выбранного таба, но использует актуальное состояние
    renderLoans();
    renderGoals();

    const totalIncomeActual = metrics.totalIncomeToDate || 0;
    const totalIncomePlanned =
      Math.max((metrics.totalIncome || 0) - totalIncomeActual, 0);
    totalIncomeEl.textContent = formatCurrency(totalIncomeActual);
    if (totalIncomePlannedEl) {
      totalIncomePlannedEl.textContent = formatCurrency(totalIncomePlanned);
    }

    const totalFixedActual = metrics.totalFixedToDate || 0;
    const totalFixedPlanned =
      Math.max((metrics.totalFixed || 0) - totalFixedActual, 0);
    totalFixedExpensesEl.textContent = formatCurrency(totalFixedActual);
    if (totalFixedPlannedEl) {
      totalFixedPlannedEl.textContent = formatCurrency(totalFixedPlanned);
    }

    const savingsActual = metrics.savingTransfersToDate || 0;
    if (autoSavingsRealEl) {
      autoSavingsRealEl.textContent = formatCurrency(savingsActual);
    }
    if (autoSavingsEl) {
    autoSavingsEl.textContent = formatCurrency(metrics.autoSavings);
    }
    flexibleBudgetEl.textContent = formatCurrency(metrics.flexibleBudget);
    plannedDailyLimitEl.textContent = formatCurrency(Math.max(metrics.plannedDailyLimit, 0));
    if (currentDailyLimitEl) {
    currentDailyLimitEl.textContent = formatCurrency(Math.max(metrics.currentDailyLimit, 0));
    }
    if (spentSoFarEl) {
    spentSoFarEl.textContent = formatCurrency(metrics.spentSoFar);
    }
    let recValue = 0;
    if (todayRecommendedEl) {
      const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      const aiMap =
        ui.aiDailyRecommendations && typeof ui.aiDailyRecommendations === "object"
          ? ui.aiDailyRecommendations
          : {};
      const aiErrors =
        ui.aiDailyErrors && typeof ui.aiDailyErrors === "object" ? ui.aiDailyErrors : {};

      const meta = currentDateStr && aiMap[currentDateStr] ? aiMap[currentDateStr] : null;
      const hasRec = meta && Number.isFinite(meta.value);
      const aiErrorMeta =
        currentDateStr && aiErrors[currentDateStr] ? aiErrors[currentDateStr] : null;

      let updatedAtText =
        aiDailyRecommendationPending ? "Думает…" : "⟳ R — reasoning, ⟳ — быстрый расчёт";

      if (hasRec) {
        recValue = Math.round(meta.value);
        if (!aiDailyRecommendationPending && Number.isFinite(meta.updatedAt)) {
          const d = new Date(meta.updatedAt);
          if (!Number.isNaN(d.getTime())) {
            const hh = String(d.getHours()).padStart(2, "0");
            const mm = String(d.getMinutes()).padStart(2, "0");
            const modelTag = meta.isReasoning ? " · R" : "";
            updatedAtText = `Обновлено: ${hh}:${mm}` + (meta.source === "ai" ? " (DeepSeek" + modelTag + ")" : "");
          }
        }

        const hasTwoValues = Number.isFinite(meta.dailyBefore) && Number.isFinite(meta.dailyAfter) && meta.nextIncome;
        if (hasTwoValues && todayRecommendedLabelEl) {
          todayRecommendedLabelEl.textContent = "до дохода";
        } else if (todayRecommendedLabelEl) {
          todayRecommendedLabelEl.textContent = "";
        }
        if (hasTwoValues && todayRecommendedAfterEl && todayRecommendedAfterValueEl) {
          todayRecommendedAfterValueEl.textContent = formatCurrency(Math.round(meta.dailyAfter));
          todayRecommendedAfterEl.classList.remove("hidden");
        } else if (todayRecommendedAfterEl) {
          todayRecommendedAfterEl.classList.add("hidden");
        }
      } else {
        if (todayRecommendedLabelEl) todayRecommendedLabelEl.textContent = "";
        if (todayRecommendedAfterEl) todayRecommendedAfterEl.classList.add("hidden");
      }

      if (aiErrorMeta && !hasRec) {
        updatedAtText = "Не удалось рассчитать рекомендацию";
      }

      todayRecommendedEl.textContent = formatCurrency(recValue);
      if (todayRecommendedUpdatedAtEl) {
        todayRecommendedUpdatedAtEl.textContent = updatedAtText;
      }
    }
    if (todaySpentEl) {
      todaySpentEl.textContent = formatCurrency(metrics.spentToday || 0);
    }
    if (todaySpentRemainderEl) {
      const remainder = recValue - (metrics.spentToday || 0);
      todaySpentRemainderEl.textContent = formatCurrency(remainder);
      todaySpentRemainderEl.className =
        "text-sm font-semibold " + (remainder < 0 ? "text-rose-600" : "text-slate-700");
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
    const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
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
      if (preset.startMonthKey && typeof preset.startMonthKey === "string") {
        if (monthKey < preset.startMonthKey) continue;
      }
      const day = Math.min(Math.max(Number.parseInt(preset.dayOfMonth, 10) || 1, 1), daysInMonth);
      const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, "0")}`;

      const skipped =
        ui.skippedRecurring &&
        ui.skippedRecurring[monthKey] &&
        ui.skippedRecurring[monthKey][preset.id] &&
        ui.skippedRecurring[monthKey][preset.id][dateStr];
      if (skipped) continue;

      // В одном месяце должна быть только одна операция из повторяемого шаблона.
      // Если пользователь оплатил раньше и изменил дату в "Ближайших событиях",
      // считаем, что платёж за этот месяц уже произошёл и не создаём вторую
      // операцию на исходную плановую дату.
      const exists = monthData.transactions.some(
        (tx) => tx.type === "recurringExpense" && tx.presetId === preset.id,
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
    const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
    const [yearStr, monthStr] = monthKey.split("-");
    const year = Number.parseInt(yearStr, 10);
    const monthIndexZeroBased = Number.parseInt(monthStr, 10) - 1;
    const daysInMonth = getDaysInMonth(year, monthIndexZeroBased);

    let changed = false;

    for (const preset of presets) {
      if (!preset.active) continue;
      const day = Math.min(Math.max(Number.parseInt(preset.dayOfMonth, 10) || 1, 1), daysInMonth);
      const dateStr = `${yearStr}-${monthStr}-${String(day).padStart(2, "0")}`;

      const skipped =
        ui.skippedRecurring &&
        ui.skippedRecurring[monthKey] &&
        ui.skippedRecurring[monthKey][preset.id] &&
        ui.skippedRecurring[monthKey][preset.id][dateStr];
      if (skipped) continue;

      const exists = monthData.transactions.some(
        // если в месяце уже есть доход с этим presetId, второй такой же не создаем
        (tx) => tx.type === "income" && tx.presetId === preset.id,
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

    function sumIncomeAndExpenses(txList) {
      let income = 0;
      let expenses = 0;
      for (const tx of txList) {
        const amount = Number(tx.amount) || 0;
        if (tx.type === "income") income += amount;
        else if (tx.type === "balanceAdjustment") {
          if (amount > 0) income += amount;
          else expenses += Math.abs(amount);
        } else if (
          tx.type === "fixedExpense" ||
          tx.type === "flexibleExpense" ||
          tx.type === "recurringExpense" ||
          tx.type === "savingTransfer"
        ) {
          expenses += amount;
        }
      }
      return { income, expenses };
    }

    const periodSums = sumIncomeAndExpenses(filtered);
    if (historyPeriodTotalsEl) {
      historyPeriodTotalsEl.textContent =
        "За период: Доходы " + formatCurrency(periodSums.income) + " · Расходы " + formatCurrency(periodSums.expenses);
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
      if (a.date !== b.date) {
        return a.date > b.date ? -1 : 1;
      }
      return (b.id || "").localeCompare(a.id || "");
    });

    const mode = getHistoryPeriodMode();
    const collapseByDay = mode === "month" || mode === "range";
    const collapsedDays = (state.ui && state.ui.historyCollapsedDays && typeof state.ui.historyCollapsedDays === "object")
      ? state.ui.historyCollapsedDays
      : {};

    function formatDayLabel(dateStr) {
      if (!dateStr || dateStr.length < 10) return dateStr;
      const d = new Date(dateStr + "T12:00:00");
      if (Number.isNaN(d.getTime())) return dateStr;
      const day = d.getDate();
      const months = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
      const month = months[d.getMonth()];
      return `${day} ${month}`;
    }

    function buildTransactionRow(tx) {
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
      const absFormatted = formatCurrency(Math.abs(amount));
      if (amount === 0) {
        amountSpan.textContent = absFormatted;
      } else if (tx.type === "income") {
        amountSpan.textContent = `+${absFormatted}`;
      } else if (
        tx.type === "flexibleExpense" ||
        tx.type === "fixedExpense" ||
        tx.type === "recurringExpense" ||
        tx.type === "savingTransfer"
      ) {
        amountSpan.textContent = `-${absFormatted}`;
      } else if (tx.type === "balanceAdjustment") {
        amountSpan.textContent = amount > 0 ? `+${absFormatted}` : `-${absFormatted}`;
      } else {
      amountSpan.textContent = formatCurrency(amount);
      }

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
        tx.type === "income" ||
        tx.type === "fixedExpense" ||
        tx.type === "flexibleExpense" ||
        tx.type === "recurringExpense";
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

      return row;
    }

    if (collapseByDay) {
      const byDay = new Map();
      for (const tx of sorted) {
        const d = tx.date || "";
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(tx);
      }
      const daysOrdered = [...byDay.keys()].sort((a, b) => (a > b ? -1 : 1));
      for (const dateStr of daysOrdered) {
        const dayTxs = byDay.get(dateStr);
        if (!dayTxs || dayTxs.length === 0) continue;
        const daySection = document.createElement("div");
        daySection.className = "border-b border-slate-700/50";
        const dayHeader = document.createElement("button");
        dayHeader.type = "button";
        dayHeader.className = "w-full flex items-center justify-between gap-2 px-2 py-2 text-left rounded-lg hover:bg-slate-800/50 transition-colors";
        const isCollapsed = !!collapsedDays[dateStr];
        const arrow = document.createElement("span");
        arrow.className = "text-[10px] text-slate-400 w-4 shrink-0";
        arrow.textContent = isCollapsed ? "▶" : "▼";
        const dayLabel = document.createElement("span");
        dayLabel.className = "text-[11px] font-medium text-slate-200";
        dayLabel.textContent = formatDayLabel(dateStr);
        const daySums = sumIncomeAndExpenses(dayTxs);
        const dayCount = document.createElement("span");
        dayCount.className = "text-[10px] text-slate-500";
        const countText = dayTxs.length === 1 ? "1 оп." : `${dayTxs.length} оп.`;
        const sumsText =
          (daySums.income > 0 ? "+" + formatCurrency(daySums.income) : "") +
          (daySums.income > 0 && daySums.expenses > 0 ? " / " : "") +
          (daySums.expenses > 0 ? "−" + formatCurrency(daySums.expenses) : "") ||
          "—";
        dayCount.textContent = countText + (daySums.income > 0 || daySums.expenses > 0 ? " · " + sumsText : "");
        const leftPart = document.createElement("span");
        leftPart.className = "flex items-center gap-1.5";
        leftPart.appendChild(arrow);
        leftPart.appendChild(dayLabel);
        dayHeader.appendChild(leftPart);
        dayHeader.appendChild(dayCount);
        daySection.appendChild(dayHeader);
        const dayContent = document.createElement("div");
        dayContent.className = isCollapsed ? "hidden" : "";
        for (const tx of dayTxs) {
          dayContent.appendChild(buildTransactionRow(tx));
        }
        daySection.appendChild(dayContent);
        onTap(dayHeader, () => {
          state.ui = state.ui && typeof state.ui === "object" ? state.ui : {};
          state.ui.historyCollapsedDays = state.ui.historyCollapsedDays && typeof state.ui.historyCollapsedDays === "object" ? state.ui.historyCollapsedDays : {};
          state.ui.historyCollapsedDays[dateStr] = !state.ui.historyCollapsedDays[dateStr];
          saveState(state);
          renderTransactionsList();
        });
        transactionsListEl.appendChild(daySection);
      }
    } else {
      for (const tx of sorted) {
        transactionsListEl.appendChild(buildTransactionRow(tx));
      }
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

    // Алиасы для вендоров подписок: всё сворачиваем в категорию "Подписки"
    const subscriptionAliases = new Set([
      "Билайн",
      "Beeline",
      "Apple",
      "App Store",
      "Сбер",
      "Сбербанк",
      "Telegram",
      "Телеграм",
    ]);

    for (const tx of expenses) {
      const amount = Number(tx.amount) || 0;
      if (amount <= 0) continue;
      totalExpenses += amount;
      let key = tx.category || "Без категории";
      if (subscriptionAliases.has(key)) {
        key = "Подписки";
      }
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
      const descHeader = document.createElement("div");
      descHeader.className = "flex items-center justify-between gap-2";

      const title = document.createElement("div");
      title.className = "text-slate-100";
      title.textContent = tx.title || "(без названия)";
      descHeader.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "flex items-center gap-1";
      const canEdit =
        tx.type === "income" ||
        tx.type === "fixedExpense" ||
        tx.type === "flexibleExpense" ||
        tx.type === "recurringExpense";
      if (canEdit) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✎";
        editBtn.title = "Редактировать операцию";
        editBtn.className =
          "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-sky-600/80 hover:border-sky-500 hover:text-white transition-colors";
        onTap(editBtn, () => startEditTransaction(tx));
        actions.appendChild(editBtn);
      }
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Удалить операцию";
      deleteBtn.className =
        "w-5 h-5 flex items-center justify-center rounded-full border border-slate-600/70 text-[11px] text-slate-300 hover:bg-rose-600/80 hover:border-rose-500 hover:text-white transition-colors";
      onTap(deleteBtn, () => deleteTransaction(tx.id));
      actions.appendChild(deleteBtn);

      descHeader.appendChild(actions);
      tdDesc.appendChild(descHeader);

      const meta = document.createElement("div");
      meta.className = "text-[10px] text-slate-500";
      const parts = [];
      if (tx.type === "income") parts.push("Доход");
      else if (tx.type === "fixedExpense") parts.push("Крупный расход");
      else if (tx.type === "recurringExpense") parts.push("Повторяемый расход");
      else if (tx.type === "flexibleExpense") parts.push("Обычный расход");
      else if (tx.type === "savingTransfer") parts.push("Перевод в накопления");
      else if (tx.type === "balanceAdjustment") parts.push("Корректировка баланса");
      if (tx.category) parts.push(tx.category);
      if (tx.note) parts.push(tx.note);
      meta.textContent = parts.join(" · ");
      tdDesc.appendChild(meta);

      const tdAmount = document.createElement("td");
      tdAmount.className = "py-1.5 text-right align-top";
      const amount = Number(tx.amount) || 0;
      const absFormatted = formatCurrency(Math.abs(amount));
      if (amount === 0) {
        tdAmount.textContent = absFormatted;
      } else if (tx.type === "income") {
        // Доходы всегда со знаком "+"
        tdAmount.textContent = `+${absFormatted}`;
      } else if (
        tx.type === "flexibleExpense" ||
        tx.type === "fixedExpense" ||
        tx.type === "recurringExpense" ||
        tx.type === "savingTransfer"
      ) {
        // Все расходы и переводы в сбережения — со знаком "-"
        tdAmount.textContent = `-${absFormatted}`;
      } else if (tx.type === "balanceAdjustment") {
        // Корректировка баланса: явный "+" для повышения, "-" уже будет в формате суммы
        if (amount > 0) {
          tdAmount.textContent = `+${absFormatted}`;
        } else {
          tdAmount.textContent = `-${absFormatted}`;
        }
      } else {
        tdAmount.textContent = formatCurrency(amount);
      }

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
        if ((tx.type === "recurringExpense" || tx.type === "income") && tx.presetId && tx.date) {
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

  function computeSavingsFromExpense(amount) {
    const amt = Number(amount) || 0;
    if (!Number.isFinite(amt) || amt <= 0) {
      return { percentPart: 0, roundingPart: 0, total: 0 };
    }
    const percentRaw = amt * 0.05;
    const percentCapped = Math.min(percentRaw, 1000);
    const percentPart = Math.round(percentCapped);
    const roundedTo50 = Math.ceil(amt / 50) * 50;
    const roundingPart = Math.max(0, roundedTo50 - amt);
    const total = percentPart + roundingPart;
    return { percentPart, roundingPart, total };
  }

  function handleTransactionSubmit(event) {
    event.preventDefault();

    const type = transactionTypeInput.value;
    const category = transactionCategoryInput.value.trim();
    const title = transactionTitleInput.value.trim();
    const amount = parseAmountFromInput(transactionAmountInput.value);
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
      // Особый случай: расход с пометкой "перевод" в категорию "Сбережения" —
      // считаем как ручной перевод денег на сбережения (savingTransfer).
      if (
        (type === "flexibleExpense" || type === "fixedExpense") &&
        expenseTransferCheckbox &&
        expenseTransferCheckbox.checked &&
        category === "Сбережения"
      ) {
      monthData.transactions.push({
          id: generateId(),
          type: "savingTransfer",
          category: "Сбережения",
          title: title || "Перевод в сбережения",
          amount,
          date,
          note,
        });
      } else {
        const tx = {
        id: generateId(),
        type,
        category,
        title,
        amount,
        date,
        note,
          isTransfer:
            expenseTransferCheckbox &&
            (type === "flexibleExpense" || type === "fixedExpense") &&
            expenseTransferCheckbox.checked
              ? true
              : undefined,
        };
        monthData.transactions.push(tx);

        // покопейочные сбережения с покупок:
        // для всех расходов, кроме ипотеки/кредитов и коммуналки, и кроме помеченных как "перевод"
        if (
          (type === "flexibleExpense" || type === "fixedExpense") &&
          category !== "Ипотека/кредит" &&
          category !== "Коммуналка" &&
          !tx.isTransfer
        ) {
          const { percentPart, roundingPart, total } = computeSavingsFromExpense(amount);
          if (total > 0) {
            const savingsNoteParts = [];
            savingsNoteParts.push(`на сбережения ${formatCurrency(total)}`);
            if (percentPart > 0) {
              savingsNoteParts.push(`5% = ${formatCurrency(percentPart)}`);
            }
            if (roundingPart > 0) {
              savingsNoteParts.push(`округление = ${formatCurrency(roundingPart)}`);
            }
            const extraNote = `Отложено ${savingsNoteParts.join(", ")}`;
            tx.note = tx.note ? `${tx.note}. ${extraNote}` : extraNote;

            monthData.transactions.push({
              id: generateId(),
              type: "savingTransfer",
              category: "Сбережения",
              title: `Сбережения с покупки «${title || category}»`,
              amount: total,
              date,
              note: `5%: ${formatCurrency(percentPart)}, округление: ${formatCurrency(roundingPart)}`,
            });
          }
        }
      }
      // если это крупная покупка и отмечено как повторяемое — создаём шаблон,
      // который начнёт работать только со следующего месяца
      if (type === "fixedExpense" && expenseRepeatCheckbox && expenseRepeatCheckbox.checked) {
        const d = date || currentDateInput.value || "";
        let day = 1;
        if (d && d.length >= 10) {
          const dd = d.slice(8, 10);
          const parsed = Number.parseInt(dd, 10);
          if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 31) {
            day = parsed;
          }
        }

        let startMonthKey = monthKey;
        if (startMonthKey) {
          const [yStr, mStr] = startMonthKey.split("-");
          let y = Number.parseInt(yStr, 10);
          let m = Number.parseInt(mStr, 10);
          if (Number.isFinite(y) && Number.isFinite(m)) {
            m += 1;
            if (m > 12) {
              m = 1;
              y += 1;
            }
            startMonthKey = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
          }
        }

        addPresetFromAi({
          type: "expense",
          amount,
          category,
          title,
          dayOfMonth: day,
          startMonthKey,
        });
      }
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

    if (addOperationModal) {
      addOperationModal.classList.add("hidden");
      addOperationModal.classList.remove("flex");
    }

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
    const amount = parseAmountFromInput(presetAmountInput.value);
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
    resetAiMemory();
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
    const newValue = parseAmountFromInput(todayBalanceInput.value);
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

  function openSavingsWithdrawModal() {
    if (!savingsWithdrawModal) return;
    const currentDateStr = currentDateInput.value;
    if (!currentDateStr) {
      alert("Сначала выберите текущую дату в месяце.");
      return;
    }
    savingsWithdrawModal.classList.remove("hidden");
    savingsWithdrawModal.classList.add("flex");
    if (savingsWithdrawAmountInput) {
      savingsWithdrawAmountInput.value = "";
      savingsWithdrawAmountInput.focus();
    }
    if (savingsWithdrawNoteInput) {
      savingsWithdrawNoteInput.value = "";
    }
  }

  function closeSavingsWithdrawModal() {
    if (!savingsWithdrawModal) return;
    savingsWithdrawModal.classList.add("hidden");
    savingsWithdrawModal.classList.remove("flex");
    if (savingsWithdrawAmountInput) savingsWithdrawAmountInput.value = "";
    if (savingsWithdrawNoteInput) savingsWithdrawNoteInput.value = "";
  }

  function openSavingsDepositModal() {
    if (!savingsDepositModal) return;
    savingsDepositModal.classList.remove("hidden");
    savingsDepositModal.classList.add("flex");
    if (savingsDepositAmountInput) {
      savingsDepositAmountInput.value = "";
      savingsDepositAmountInput.focus();
    }
    if (savingsDepositDateInput && currentDateInput && currentDateInput.value) {
      savingsDepositDateInput.value = currentDateInput.value;
    }
    if (savingsDepositNoteInput) {
      savingsDepositNoteInput.value = "";
    }
  }

  function closeSavingsDepositModal() {
    if (!savingsDepositModal) return;
    savingsDepositModal.classList.add("hidden");
    savingsDepositModal.classList.remove("flex");
    if (savingsDepositAmountInput) savingsDepositAmountInput.value = "";
    if (savingsDepositDateInput) savingsDepositDateInput.value = "";
    if (savingsDepositNoteInput) savingsDepositNoteInput.value = "";
  }

  function handleSavingsDepositSubmit(event) {
    event.preventDefault();
    if (!savingsDepositAmountInput) return;

    const amount = parseAmountFromInput(savingsDepositAmountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Введите положительную сумму для перевода в сбережения.");
      return;
    }

    const dateStr =
      (savingsDepositDateInput && savingsDepositDateInput.value) ||
      (currentDateInput && currentDateInput.value) ||
      "";
    const monthKeyFromDate = getMonthKeyFromDate(dateStr);
    if (!monthKeyFromDate) {
      alert("Некорректная дата для операции.");
      return;
    }

    const note =
      (savingsDepositNoteInput && savingsDepositNoteInput.value.trim()) || "Перевод на сбережения";

    const monthData = ensureMonth(state, monthKeyFromDate);
    monthData.transactions.push({
      id: generateId(),
      type: "savingTransfer",
      category: "Сбережения",
      title: "Перевод в сбережения",
      amount,
      date: dateStr,
      note,
    });

    saveStateToServer();
    closeSavingsDepositModal();
    render();
  }

  function handleSavingsWithdrawSubmit(event) {
    event.preventDefault();
    const currentDateStr = currentDateInput.value;
    if (!currentDateStr) {
      alert("Сначала выберите текущую дату в месяце.");
      return;
    }
    if (!savingsWithdrawAmountInput) return;
    const amount = parseAmountFromInput(savingsWithdrawAmountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Введите положительную сумму для вывода из сбережений.");
      return;
    }
    const note = savingsWithdrawNoteInput ? savingsWithdrawNoteInput.value.trim() : "";

    const monthKeyFromDate = getMonthKeyFromDate(currentDateStr);
    if (!monthKeyFromDate) {
      alert("Некорректная дата для операции.");
      return;
    }
    const monthData = ensureMonth(state, monthKeyFromDate);

    // Вывод из сбережений: savingTransfer с отрицательной суммой.
    monthData.transactions.push({
      id: generateId(),
      type: "savingTransfer",
      category: "Сбережения",
      title: "Вывод из сбережений",
      amount: -amount,
      date: currentDateStr,
      note: note || "Перевод со сбережений на баланс",
    });

    saveStateToServer();
    closeSavingsWithdrawModal();
    render();
  }

  function compressImageForAi(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const maxSize = 1024;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxSize || h > maxSize) {
          if (w >= h) {
            h = Math.round((h * maxSize) / w);
            w = maxSize;
          } else {
            w = Math.round((w * maxSize) / h);
            h = maxSize;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const jpeg = canvas.toDataURL("image/jpeg", 0.85);
          resolve(jpeg || dataUrl);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function handleAiImagesSelected(files) {
    if (!files || !files.length) return;
    const maxImages = 4;
    aiPendingImages = aiPendingImages || [];
    const toRead = Array.from(files).slice(0, maxImages - aiPendingImages.length);
    if (toRead.length === 0) return;

    for (const file of toRead) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        let url = e.target?.result;
        if (typeof url !== "string") return;
        url = await compressImageForAi(url);
        aiPendingImages.push(url);
        if (aiImagePreview) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = "изображение для AI";
          img.className = "w-8 h-8 rounded-md object-cover border border-slate-700/80";
          aiImagePreview.appendChild(img);
        }
      };
      reader.readAsDataURL(file);
    }
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

  if (monthSelect) {
  monthSelect.addEventListener("change", () => {
    const monthKey = monthSelect.value;
    editingTransactionId = null;
      resetAiMemory();
    if (monthKey) {
      syncPeriodInputsForMonth(monthKey);
    }
    render();
  });
  }

  if (currentDateInput) {
  currentDateInput.addEventListener("change", handleMonthOrDateChange);
  }

  if (transactionsFilterInput) {
  transactionsFilterInput.addEventListener("change", handleFilterChange);
  }

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

  if (exportDataButton) {
    onTap(exportDataButton, () => {
      let savingsTotal = 0;
      const monthsObj = state.months || {};
      for (const mk of Object.keys(monthsObj)) {
        const m = monthsObj[mk];
        if (!m || !Array.isArray(m.transactions)) continue;
        for (const tx of m.transactions) {
          if (tx && tx.type === "savingTransfer" && Number.isFinite(Number(tx.amount))) savingsTotal += Number(tx.amount);
        }
      }
      let balanceTodayExport = null;
      const currentDateStr = currentDateInput && currentDateInput.value;
      if (currentDateStr) {
        let b = 0;
        for (const mk of Object.keys(monthsObj)) {
          const m = monthsObj[mk];
          if (!m || !Array.isArray(m.transactions)) continue;
          for (const tx of m.transactions) {
            if (!tx) continue;
            const txDate = tx.date || "";
            if (!txDate || txDate > currentDateStr) continue;
            const amount = Number(tx.amount) || 0;
            if (!Number.isFinite(amount) || amount === 0) continue;
            if (tx.type === "income" || tx.type === "balanceAdjustment") b += amount;
            else if (["fixedExpense", "recurringExpense", "flexibleExpense", "savingTransfer"].includes(tx.type)) b -= amount;
          }
        }
        balanceTodayExport = b;
      }
      const payload = {
        ...state,
        _exportMeta: {
          exportedAt: new Date().toISOString(),
          version: "financePlannerData_v2",
          summary: {
            monthsCount: Object.keys(monthsObj).length,
            transactionsCount: Object.values(monthsObj).reduce((acc, m) => acc + (Array.isArray(m && m.transactions) ? m.transactions.length : 0), 0),
            goalsCount: Array.isArray(state.goals) ? state.goals.length : 0,
            loansCount: Array.isArray(state.loans) ? state.loans.length : 0,
            presetsCount: (Array.isArray(state.fixedExpensePresets) ? state.fixedExpensePresets.length : 0) + (Array.isArray(state.incomePresets) ? state.incomePresets.length : 0),
            savingsTotal,
            balanceToday: balanceTodayExport,
          },
        },
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "finance-planner-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  if (importDataButton && importDataInput) {
    onTap(importDataButton, () => importDataInput.click());
    importDataInput.addEventListener("change", () => {
      const file = importDataInput.files && importDataInput.files[0];
      importDataInput.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = reader.result;
          if (typeof raw !== "string") return;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") {
            alert("В файле нет валидных данных.");
            return;
          }
          const hasData =
            (parsed.months && typeof parsed.months === "object") ||
            Array.isArray(parsed.fixedExpensePresets) ||
            Array.isArray(parsed.incomePresets) ||
            Array.isArray(parsed.goals) ||
            Array.isArray(parsed.loans);
          if (!hasData) {
            alert("В файле нет данных резервной копии (история, шаблоны, цели или займы). Выберите другой файл.");
            return;
          }
          if (!confirm("Заменить текущие данные загруженными? Восстановятся: история, остаток на балансе, цели, займы, шаблоны, сбережения. Текущие данные на этом устройстве будут перезаписаны.")) return;
          const merged = loadState();
          const next = {
            months: parsed.months && typeof parsed.months === "object" ? parsed.months : merged.months,
            categories: parsed.categories && typeof parsed.categories === "object" ? parsed.categories : merged.categories,
            fixedExpensePresets: Array.isArray(parsed.fixedExpensePresets) ? parsed.fixedExpensePresets : merged.fixedExpensePresets,
            incomePresets: Array.isArray(parsed.incomePresets) ? parsed.incomePresets : merged.incomePresets,
            loans: Array.isArray(parsed.loans) ? parsed.loans : merged.loans,
            goals: Array.isArray(parsed.goals) ? parsed.goals : merged.goals,
            ui: parsed.ui && typeof parsed.ui === "object" ? parsed.ui : merged.ui,
          };
          state.months = next.months;
          state.categories = next.categories;
          state.fixedExpensePresets = next.fixedExpensePresets;
          state.incomePresets = next.incomePresets;
          state.loans = next.loans;
          state.goals = next.goals;
          state.ui = next.ui;
          saveState(state);
          if (typeof saveStateToServer === "function") saveStateToServer();
          render();
          alert("Данные восстановлены: история, остаток на балансе, цели, займы, шаблоны, сбережения. Можно продолжать работу.");
        } catch (e) {
          console.error("Import failed", e);
          alert("Ошибка при чтении файла. Убедитесь, что выбран файл резервной копии (.json).");
        }
      };
      reader.readAsText(file, "UTF-8");
    });
  }

  if (todayBalanceEditButton) {
    onTap(todayBalanceEditButton, openTodayBalanceEdit);
  }
  if (savingsWithdrawOpenButton) {
    onTap(savingsWithdrawOpenButton, openSavingsWithdrawModal);
  }
  if (savingsWithdrawCloseButton) {
    onTap(savingsWithdrawCloseButton, closeSavingsWithdrawModal);
  }
  if (savingsWithdrawCancelButton) {
    onTap(savingsWithdrawCancelButton, closeSavingsWithdrawModal);
  }
  if (savingsWithdrawForm) {
    savingsWithdrawForm.addEventListener("submit", handleSavingsWithdrawSubmit);
  }
  if (savingsDepositOpenButton) {
    onTap(savingsDepositOpenButton, openSavingsDepositModal);
  }
  if (savingsDepositCloseButton) {
    onTap(savingsDepositCloseButton, closeSavingsDepositModal);
  }
  if (savingsDepositCancelButton) {
    onTap(savingsDepositCancelButton, closeSavingsDepositModal);
  }
  if (savingsDepositForm) {
    savingsDepositForm.addEventListener("submit", handleSavingsDepositSubmit);
  }
  if (aiImageButton && aiImageInput) {
    onTap(aiImageButton, () => {
      aiImageInput.click();
    });
    aiImageInput.addEventListener("change", (e) => {
      const files = e.target.files;
      handleAiImagesSelected(files);
    });
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
      if (addOperationModal) {
        addOperationModal.classList.remove("hidden");
        addOperationModal.classList.add("flex");
      }
      focusTransactionForm();
    });
  }
  function runDailyRecommendationRefresh(mode) {
    const currentDateStr = currentDateInput ? currentDateInput.value : null;
    if (!currentDateStr) {
      alert("Сначала выберите текущую дату в месяце.");
      return;
    }
    const btnR = todayRecommendedRefreshReasoning;
    const btnF = todayRecommendedRefreshFast;
    const prevDR = btnR ? btnR.disabled : false;
    const prevDF = btnF ? btnF.disabled : false;
    const prevCR = btnR ? btnR.textContent : "";
    const prevCF = btnF ? btnF.textContent : "";
    if (btnR) {
      btnR.disabled = true;
      btnR.textContent = "…";
    }
    if (btnF) {
      btnF.disabled = true;
      btnF.textContent = "…";
    }
    aiDailyRecommendationPending = true;
    aiDailyRecommendationRequestDate = currentDateStr;
    requestAiDailyRecommendation(currentDateStr, mode).then((result) => {
      aiDailyRecommendationPending = false;
      if (btnR) {
        btnR.disabled = prevDR;
        btnR.textContent = "⟳ R";
      }
      if (btnF) {
        btnF.disabled = prevDF;
        btnF.textContent = "⟳";
      }
      if (!result || typeof result !== "object" || !Number.isFinite(result.value)) {
        const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
        const errObj = ui.aiDailyErrors && ui.aiDailyErrors[currentDateStr];
        const errMsg = (errObj && typeof errObj.message === "string" && errObj.message.trim()) || "Не удалось рассчитать рекомендацию.";
        render();
        alert(errMsg);
        return;
      }
      render();
    });
  }

  if (todayRecommendedRefreshReasoning) {
    onTap(todayRecommendedRefreshReasoning, () => runDailyRecommendationRefresh("reasoning"));
  }
  if (todayRecommendedRefreshFast) {
    onTap(todayRecommendedRefreshFast, () => runDailyRecommendationRefresh("fast"));
  }
  if (todayRecommendedExplainButton) {
    onTap(todayRecommendedExplainButton, () => {
      const currentDateStr = currentDateInput ? currentDateInput.value : null;
      if (!currentDateStr) {
        alert("Сначала выберите текущую дату в месяце.");
        return;
      }
      const ui = state.ui && typeof state.ui === "object" ? state.ui : {};
      const aiMap =
        ui.aiDailyRecommendations && typeof ui.aiDailyRecommendations === "object"
          ? ui.aiDailyRecommendations
          : {};
      const meta = aiMap[currentDateStr];
      if (!meta || !Number.isFinite(meta.value)) {
        alert("Нет рекомендации. Нажмите ⟳ рядом с суммой, чтобы получить расчёт.");
        return;
      }

      const hasTwoValues = Number.isFinite(meta.dailyBefore) && Number.isFinite(meta.dailyAfter) && meta.nextIncome;
      let valueText = hasTwoValues
        ? `До дохода (${meta.nextIncome.title || ""}): ${formatCurrency(meta.dailyBefore)} ₽/день\nПосле дохода: ${formatCurrency(meta.dailyAfter)} ₽/день`
        : `Рекомендация на сегодня: ${formatCurrency(meta.value)}`;

      let statusText = "";
      const status = typeof meta.status === "string" ? meta.status.trim().toLowerCase() : "";
      if (status === "warning") statusText = "Статус: есть риск перерасхода.";
      else if (status === "critical") statusText = "Статус: высокий риск кассового разрыва, расходуйте осторожно.";
      else if (status === "ok") statusText = "Статус: всё в пределах нормы.";

      const reasonText =
        meta.reason && typeof meta.reason === "string" && meta.reason.trim()
          ? meta.reason.trim()
          : "Пояснение не сформировано.";
      const tips = Array.isArray(meta.optimizationTips) && meta.optimizationTips.length > 0
        ? "Как оптимизировать расходы:\n• " + meta.optimizationTips.join("\n• ")
        : "";
      const sourceLabel = meta.source === "ai"
        ? "Источник: DeepSeek" + (meta.isReasoning ? " · reasoning" : "") + (meta.model ? " — " + meta.model : "")
        : "Пояснение: автоматическое";

      const parts = [valueText];
      if (statusText) parts.push(statusText);
      parts.push(reasonText);
      if (tips) parts.push(tips);
      parts.push(sourceLabel);

      if (aiDailyExplainText) aiDailyExplainText.textContent = parts.join("\n\n");
      if (aiDailyExplainModal) {
        aiDailyExplainModal.classList.remove("hidden");
        aiDailyExplainModal.classList.add("flex");
      }
    });
  }
  if (aiDailyExplainCloseButton && aiDailyExplainModal) {
    onTap(aiDailyExplainCloseButton, () => {
      aiDailyExplainModal.classList.add("hidden");
      aiDailyExplainModal.classList.remove("flex");
    });
    aiDailyExplainModal.addEventListener("click", (e) => {
      if (e.target === aiDailyExplainModal) {
        aiDailyExplainModal.classList.add("hidden");
        aiDailyExplainModal.classList.remove("flex");
      }
    });
  }
  if (plannedDailyLimitHelpButton) {
    plannedDailyLimitHelpButton.addEventListener("click", () => {
      alert(
        "Плановый дневной лимит — это сколько в среднем можно тратить в день в этом месяце, " +
          "если равномерно расходовать гибкий бюджет.\n\n" +
          "Считается так: все доходы месяца минус крупные/фиксированные расходы минус 15% на сбережения = гибкий бюджет месяца. " +
          "Затем гибкий бюджет делится на количество дней в месяце.",
      );
    });
  }
  if (tabGoalsButton) {
    onTap(tabGoalsButton, () => setActiveTab("goals"));
  }
  if (tabLoansButton) {
    onTap(tabLoansButton, () => setActiveTab("loans"));
  }
  if (loanForm) {
    loanForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const kind = (loanKindInput && loanKindInput.value) || "borrow";
      const name = (loanNameInput && loanNameInput.value.trim()) || "";
      const rawAmount = (loanAmountInput && loanAmountInput.value) || "";
      const amount = parseAmountFromInput(rawAmount);
      const dueDate = loanDueDateInput && loanDueDateInput.value ? loanDueDateInput.value : "";
      const note = loanNoteInput && loanNoteInput.value ? loanNoteInput.value.trim() : "";
      if (!name) {
        alert("Укажите, кому или у кого займ.");
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        alert("Введите корректную сумму займа.");
        return;
      }
      const loans = getLoansArray();
      loans.push({
        id: generateId(),
        kind,
        name,
        amount,
        balance: amount,
        dueDate,
        note,
        createdAt: new Date().toISOString(),
      });
      if (loanAmountInput) loanAmountInput.value = "";
      if (loanNoteInput) loanNoteInput.value = "";
      saveState(state);
      saveStateToServer();
      render();
    });
  }

  // Goals: create / edit via верхняя форма
  if (goalForm) {
    goalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = (goalNameInput && goalNameInput.value.trim()) || "";
      const category = (goalCategoryInput && goalCategoryInput.value) || "";
      const targetRaw = goalTargetAmountInput && goalTargetAmountInput.value;
      const targetAmount = parseAmountFromInput(targetRaw);
      const dueDate = goalDueDateInput && goalDueDateInput.value ? goalDueDateInput.value : "";
      const note = goalNoteInput && goalNoteInput.value ? goalNoteInput.value.trim() : "";

      if (!name) {
        alert("Укажите название цели.");
        return;
      }
      if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
        alert("Введите корректную сумму цели.");
        return;
      }

      const goals = getGoalsArray();
      goals.push({
        id: generateId(),
        name,
        category,
        targetAmount,
        currentAmount: 0,
        dueDate,
        note,
        createdAt: new Date().toISOString(),
      });

      if (goalNameInput) goalNameInput.value = "";
      if (goalTargetAmountInput) goalTargetAmountInput.value = "";
      if (goalDueDateInput) goalDueDateInput.value = "";
      if (goalNoteInput) goalNoteInput.value = "";

      saveState(state);
      saveStateToServer();
      render();
    });
  }

  if (goalEditCloseButton) {
    onTap(goalEditCloseButton, closeGoalEditModal);
  }
  if (goalEditCancelButton) {
    onTap(goalEditCancelButton, closeGoalEditModal);
  }
  if (goalEditModal) {
    goalEditModal.addEventListener("click", (e) => {
      if (e.target === goalEditModal) {
        closeGoalEditModal();
      }
    });
  }
  if (goalEditForm) {
    goalEditForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!editingGoalId) {
        closeGoalEditModal();
        return;
      }
      const goals = getGoalsArray();
      const goal = goals.find((g) => g && g.id === editingGoalId);
      if (!goal) {
        closeGoalEditModal();
        return;
      }

      const name = (goalEditNameInput && goalEditNameInput.value.trim()) || "";
      const category = (goalEditCategoryInput && goalEditCategoryInput.value) || "";
      const targetRaw = goalEditTargetAmountInput && goalEditTargetAmountInput.value;
      const targetAmount = parseAmountFromInput(targetRaw);
      const dueDate =
        goalEditDueDateInput && goalEditDueDateInput.value ? goalEditDueDateInput.value : "";
      const note = goalEditNoteInput && goalEditNoteInput.value ? goalEditNoteInput.value.trim() : "";

      if (!name) {
        alert("Укажите название цели.");
        return;
      }
      if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
        alert("Введите корректную сумму цели.");
        return;
      }

      goal.name = name;
      goal.category = category;
      goal.targetAmount = targetAmount;
      goal.dueDate = dueDate;
      goal.note = note;

      saveState(state);
      saveStateToServer();
      closeGoalEditModal();
      render();
    });
  }

  if (goalActionCloseButton) {
    onTap(goalActionCloseButton, closeGoalActionModal);
  }
  if (goalActionCancelButton) {
    onTap(goalActionCancelButton, closeGoalActionModal);
  }
  if (goalActionModal) {
    goalActionModal.addEventListener("click", (e) => {
      if (e.target === goalActionModal) {
        closeGoalActionModal();
      }
    });
  }
  if (goalActionForm) {
    goalActionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!goalActionGoalId || !goalActionMode) {
        closeGoalActionModal();
        return;
      }
      const goals = getGoalsArray();
      const goal = goals.find((g) => g && g.id === goalActionGoalId);
      if (!goal) {
        closeGoalActionModal();
        return;
      }

      const amount = parseAmountFromInput(goalActionAmountInput && goalActionAmountInput.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        alert("Введите корректную сумму.");
        return;
      }

      const maxAvailable = Number(goal.currentAmount) || 0;
      const signedAmount =
        goalActionMode === "withdraw" ? -Math.min(amount, maxAvailable) : amount;
      if (goalActionMode === "withdraw" && maxAvailable <= 0) {
        alert("По этой цели пока нет накоплений для вывода.");
        return;
      }

      const date =
        (goalActionDateInput && goalActionDateInput.value) ||
        (currentDateInput && currentDateInput.value) ||
        new Date().toISOString().slice(0, 10);
      const note =
        (goalActionNoteInput && goalActionNoteInput.value.trim()) ||
        (goalActionMode === "withdraw"
          ? `Вывод с цели "${goal.name || "Цель"}"`
          : `Вклад в цель "${goal.name || "Цель"}"`);

      const monthKey = getMonthKeyFromDate(date);
      if (monthKey) {
        const monthData = ensureMonth(state, monthKey);
        monthData.transactions.push({
          id: generateId(),
          type: "savingTransfer",
          category: "Цели",
          title: `Цель: ${goal.name || "Цель"}`,
          amount: signedAmount,
          date,
          note,
          goalId: goal.id,
        });
      }

      const current = Number(goal.currentAmount) || 0;
      goal.currentAmount =
        goalActionMode === "withdraw"
          ? Math.max(current + signedAmount, 0)
          : current + signedAmount;

      saveState(state);
      saveStateToServer();
      closeGoalActionModal();
      render();
    });
  }

  // Loans: action (pay/receive)
  if (loanActionCloseButton) onTap(loanActionCloseButton, closeLoanActionModal);
  if (loanActionCancelButton) onTap(loanActionCancelButton, closeLoanActionModal);
  if (loanActionModal) {
    loanActionModal.addEventListener("click", (e) => {
      if (e.target === loanActionModal) closeLoanActionModal();
    });
  }
  if (loanActionForm) {
    loanActionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!loanActionLoanId || !loanActionMode) return;
      const loans = getLoansArray();
      const loan = loans.find((l) => l && l.id === loanActionLoanId);
      if (!loan) return;

      const balance = Number(loan.balance ?? loan.amount ?? 0) || 0;
      const amount = parseAmountFromInput(loanActionAmountInput?.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        alert("Введите корректную сумму.");
        return;
      }
      if (amount > balance) {
        alert("Сумма больше остатка по займу.");
        return;
      }
      const dateStr =
        (loanActionDateInput && loanActionDateInput.value) ||
        (currentDateInput && currentDateInput.value) ||
        "";
      const monthKeyFromDate = getMonthKeyFromDate(dateStr);
      if (!monthKeyFromDate) {
        alert("Некорректная дата.");
        return;
      }
      const note = (loanActionNoteInput && loanActionNoteInput.value.trim()) || "";
      const monthData = ensureMonth(state, monthKeyFromDate);

      if (loanActionMode === "receive") {
        monthData.transactions.push({
          id: generateId(),
          type: "income",
          category: "Займы",
          title: `Возврат займа «${loan.name || "Без имени"}»`,
          amount,
          date: dateStr,
          note: note || loan.note || "",
        });
      } else {
        monthData.transactions.push({
          id: generateId(),
          type: "flexibleExpense",
          category: "Займы",
          title: `Погашение займа «${loan.name || "Без имени"}»`,
          amount,
          date: dateStr,
          note: note || loan.note || "",
        });
      }
      loan.balance = Math.max(0, balance - amount);
      saveState(state);
      saveStateToServer();
      closeLoanActionModal();
      render();
    });
  }

  // Loans: edit modal
  if (loanEditCloseButton) onTap(loanEditCloseButton, closeLoanEditModal);
  if (loanEditCancelButton) onTap(loanEditCancelButton, closeLoanEditModal);
  if (loanEditModal) {
    loanEditModal.addEventListener("click", (e) => {
      if (e.target === loanEditModal) closeLoanEditModal();
    });
  }
  if (loanEditForm) {
    loanEditForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!editingLoanId) return;
      const loans = getLoansArray();
      const loan = loans.find((l) => l && l.id === editingLoanId);
      if (!loan) return;

      const kind = String(loanEditKindInput?.value || loan.kind || "borrow");
      const name = String(loanEditNameInput?.value || "").trim();
      const amount = parseAmountFromInput(loanEditAmountInput?.value);
      const balance = parseAmountFromInput(loanEditBalanceInput?.value);
      const dueDate = String(loanEditDueDateInput?.value || "").trim();
      const note = String(loanEditNoteInput?.value || "").trim();

      if (!name) {
        alert("Укажите имя/банк.");
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        alert("Введите корректную сумму займа.");
        return;
      }
      if (!Number.isFinite(balance) || balance < 0) {
        alert("Введите корректный остаток.");
        return;
      }

      loan.kind = kind;
      loan.name = name;
      loan.amount = amount;
      loan.balance = Math.min(balance, amount);
      loan.dueDate = dueDate;
      loan.note = note;

      saveState(state);
      saveStateToServer();
      closeLoanEditModal();
      render();
    });
  }
  if (closeAddOperationModalButton) {
    onTap(closeAddOperationModalButton, () => {
      if (addOperationModal) {
        addOperationModal.classList.add("hidden");
        addOperationModal.classList.remove("flex");
      }
    });
  }
  if (addOperationModal) {
    addOperationModal.addEventListener("click", (e) => {
      if (e.target === addOperationModal) {
        addOperationModal.classList.add("hidden");
        addOperationModal.classList.remove("flex");
      }
    });
  }
  if (aiChatButton) {
    onTap(aiChatButton, () => {
      openAiChatModal();
    });
  }
  if (aiChatCloseButton) {
    onTap(aiChatCloseButton, () => {
      closeAiChatModal();
    });
  }
  if (aiChatModal) {
    aiChatModal.addEventListener("click", (e) => {
      if (e.target === aiChatModal) {
        closeAiChatModal();
      }
    });
  }
  if (aiChatForm) {
    aiChatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = aiChatInput ? aiChatInput.value : "";
      if (aiChatInput) {
        aiChatInput.value = "";
      }
      sendAiMessage(value, "fast");
    });
  }

  function submitAiChatWithMode(mode) {
    const value = aiChatInput ? aiChatInput.value.trim() : "";
    const hasImages = Array.isArray(aiPendingImages) && aiPendingImages.length > 0;
    if (!value && !hasImages) return;
    if (aiChatInput) {
      aiChatInput.value = "";
    }
    sendAiMessage(value || "[изображение]", mode);
  }

  if (aiChatSendReasoning) {
    aiChatSendReasoning.addEventListener("click", () => submitAiChatWithMode("reasoning"));
  }
  if (aiChatSendFast) {
    aiChatSendFast.addEventListener("click", () => submitAiChatWithMode("fast"));
  }

  let aiPromptChoiceMode = null;

  function hideAiPromptChoice() {
    aiPromptChoiceMode = null;
    if (aiChatPromptChoice) aiChatPromptChoice.classList.add("hidden");
    if (aiChatGoalSelect) {
      aiChatGoalSelect.classList.add("hidden");
      aiChatGoalSelect.innerHTML = '<option value="">— выберите цель —</option>';
    }
    if (aiChatLoanSelect) {
      aiChatLoanSelect.classList.add("hidden");
      aiChatLoanSelect.innerHTML = '<option value="">— выберите долг —</option>';
    }
  }

  function showAiPromptGoalChoice() {
    const goals = getGoalsArray();
    if (!goals.length) {
      alert("Сначала добавьте цель в разделе «Цели».");
      return;
    }
    hideAiPromptChoice();
    aiPromptChoiceMode = "goal";
    if (aiChatPromptChoiceLabel) aiChatPromptChoiceLabel.textContent = "Выберите цель:";
    if (aiChatGoalSelect) {
      aiChatGoalSelect.classList.remove("hidden");
      aiChatGoalSelect.innerHTML = '<option value="">— выберите цель —</option>';
      for (const g of goals) {
        const opt = document.createElement("option");
        opt.value = g.id || "";
        const target = Number(g.targetAmount) || 0;
        const current = Number(g.currentAmount) || 0;
        opt.textContent = (g.name || "Цель") + " — " + formatCurrency(current) + " / " + formatCurrency(target);
        aiChatGoalSelect.appendChild(opt);
      }
    }
    if (aiChatLoanSelect) aiChatLoanSelect.classList.add("hidden");
    if (aiChatPromptChoice) aiChatPromptChoice.classList.remove("hidden");
  }

  function showAiPromptDebtChoice() {
    const loans = getLoansArray().filter((l) => l && (l.kind === "borrow" || l.kind === "credit"));
    if (!loans.length) {
      alert("Сначала добавьте долг («Я должен» или «Кредит») в разделе «Займы».");
      return;
    }
    hideAiPromptChoice();
    aiPromptChoiceMode = "debt";
    if (aiChatPromptChoiceLabel) aiChatPromptChoiceLabel.textContent = "Выберите долг:";
    if (aiChatLoanSelect) {
      aiChatLoanSelect.classList.remove("hidden");
      aiChatLoanSelect.innerHTML = '<option value="">— выберите долг —</option>';
      for (const l of loans) {
        const opt = document.createElement("option");
        opt.value = l.id || "";
        const balance = Number(l.balance ?? l.amount ?? 0) || 0;
        const kind = l.kind === "credit" ? "Кредит" : "Я должен";
        opt.textContent = kind + ": " + (l.name || "Долг") + " — " + formatCurrency(balance);
        aiChatLoanSelect.appendChild(opt);
      }
    }
    if (aiChatGoalSelect) aiChatGoalSelect.classList.add("hidden");
    if (aiChatPromptChoice) aiChatPromptChoice.classList.remove("hidden");
  }

  document.querySelectorAll(".ai-prompt-btn").forEach((btn) => {
    onTap(btn, () => {
      const prompt = btn.getAttribute("data-ai-prompt");
      if (prompt === "day") {
        hideAiPromptChoice();
        sendAiMessage("Дай рекомендацию по тратам на сегодня.");
      } else if (prompt === "month") {
        hideAiPromptChoice();
        sendAiMessage("Дай рекомендацию по бюджету на месяц.");
      } else if (prompt === "analysis") {
        hideAiPromptChoice();
        sendAiMessage("Проанализируй мои расходы за текущий месяц и дай советы по оптимизации.");
      } else if (prompt === "goal") {
        showAiPromptGoalChoice();
      } else if (prompt === "debt") {
        showAiPromptDebtChoice();
      }
    });
  });

  if (aiChatPromptChoiceSend) {
    onTap(aiChatPromptChoiceSend, () => {
      if (aiPromptChoiceMode === "goal" && aiChatGoalSelect) {
        const goalId = aiChatGoalSelect.value;
        if (!goalId) {
          alert("Выберите цель.");
          return;
        }
        const goals = getGoalsArray();
        const goal = goals.find((g) => g && g.id === goalId);
        if (!goal) return;
        const target = Number(goal.targetAmount) || 0;
        const current = Number(goal.currentAmount) || 0;
        const due = goal.dueDate || "без срока";
        const msg =
          "Дай рекомендацию, как накопить на цель «" +
          (goal.name || "Цель") +
          "». Нужно накопить " +
          formatCurrency(target) +
          ", уже накоплено " +
          formatCurrency(current) +
          ", осталось " +
          formatCurrency(Math.max(0, target - current)) +
          ". Срок: " +
          due +
          ".";
        hideAiPromptChoice();
        sendAiMessage(msg);
      } else if (aiPromptChoiceMode === "debt" && aiChatLoanSelect) {
        const loanId = aiChatLoanSelect.value;
        if (!loanId) {
          alert("Выберите долг.");
          return;
        }
        const loans = getLoansArray();
        const loan = loans.find((l) => l && l.id === loanId);
        if (!loan) return;
        const balance = Number(loan.balance ?? loan.amount ?? 0) || 0;
        const due = loan.dueDate || "без срока";
        const kind = loan.kind === "credit" ? "кредит" : "долг";
        const msg =
          "Дай рекомендацию, как погасить " +
          kind +
          " «" +
          (loan.name || "Долг") +
          "». Остаток к погашению: " +
          formatCurrency(balance) +
          ". Срок: " +
          due +
          ".";
        hideAiPromptChoice();
        sendAiMessage(msg);
      }
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

