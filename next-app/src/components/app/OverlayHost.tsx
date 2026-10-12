"use client";

import { AccountSheet } from "./sheets/AccountSheets";
import { AiChatSheet } from "./sheets/AiChatSheet";
import { WhatsNewSheet } from "./sheets/WhatsNewSheet";
import { AuthSheet } from "./sheets/AuthSheet";
import { GoalMoneySheet, GoalSheet } from "./sheets/GoalSheets";
import { LimitSheet } from "./sheets/LimitSheet";
import { ReviewSheet } from "./sheets/ReviewSheet";
import { SmsPasteSheet } from "./sheets/SmsPasteSheet";
import { LoanPaymentSheet, LoanSheet } from "./sheets/LoanSheets";
import { BalanceSheet, ExplainSheet, PlannedSheet, SavingsSheet } from "./sheets/MoneySheets";
import { TemplateSheet } from "./sheets/TemplateSheet";
import { TransactionSheet } from "./TransactionSheet";
import { useUi } from "./overlays";

/** Рендерит открытое окно. key сбрасывает состояние формы при открытии другого объекта. */
export function OverlayHost() {
  const { overlay } = useUi();
  if (!overlay) return null;
  switch (overlay.kind) {
    case "tx":
      return <TransactionSheet key={overlay.txId ?? "new"} txId={overlay.txId} preset={overlay.preset} />;
    case "template":
      return <TemplateSheet key={overlay.templateId ?? "new"} templateId={overlay.templateId} preset={overlay.preset} />;
    case "goal":
      return <GoalSheet key={overlay.goalId ?? "new"} goalId={overlay.goalId} />;
    case "goalMoney":
      return <GoalMoneySheet key={overlay.goalId} goalId={overlay.goalId} direction={overlay.direction} />;
    case "loan":
      return <LoanSheet key={overlay.loanId ?? "new"} loanId={overlay.loanId} />;
    case "loanPayment":
      return <LoanPaymentSheet key={overlay.loanId} loanId={overlay.loanId} />;
    case "savings":
      return <SavingsSheet direction={overlay.direction} />;
    case "balance":
      return <BalanceSheet key={overlay.accountId ?? "main"} accountId={overlay.accountId} />;
    case "account":
      return <AccountSheet key={overlay.accountId ?? "new"} accountId={overlay.accountId} preset={overlay.preset} />;
    case "transfer":
      // Перевод — то же окно операции, сразу на «Перевод».
      return (
        <TransactionSheet
          preset={{ type: "transfer", from: overlay.from, to: overlay.to, amount: overlay.amount, resolveBank: overlay.resolveBank }}
        />
      );
    case "explain":
      return <ExplainSheet />;
    case "planned":
      return <PlannedSheet templateId={overlay.templateId} month={overlay.month} />;
    case "ai":
      return <AiChatSheet initialPrompt={overlay.prompt} threadId={overlay.threadId} />;
    case "whatsNew":
      return <WhatsNewSheet />;
    case "auth":
      return <AuthSheet mode={overlay.mode ?? "login"} />;
    case "limit":
      return <LimitSheet key={overlay.category ?? "new"} category={overlay.category} />;
    case "review":
      return <ReviewSheet />;
    case "sms":
      return <SmsPasteSheet />;
  }
}
