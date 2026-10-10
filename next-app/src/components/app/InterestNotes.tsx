"use client";

import type { CreditSummary } from "@/domain/accounts";
import { useToday } from "@/client/react";
import { interestLines } from "./accounts";

const TONE = { muted: "text-muted", warning: "font-medium text-warning", negative: "font-medium text-negative" } as const;

/** Беспроцентный период и проценты кредитки или долга — строками по видам операций. */
export function InterestNotes({ summary, className = "" }: { summary: CreditSummary; className?: string }) {
  const today = useToday();
  const lines = interestLines(summary, today);
  if (!lines.length) return null;
  return (
    <div className={`space-y-1 ${className}`}>
      {lines.map((line) => (
        <p key={line.text} className={`text-sm ${TONE[line.tone]}`}>
          {line.text}
        </p>
      ))}
    </div>
  );
}
