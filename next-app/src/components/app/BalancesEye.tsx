"use client";

import { hideBalances, revealBalances, useBalancesPrivacy } from "@/client/privacy";
import { IconButton } from "../ui/Button";

/** Глазок у сумм счетов: спрятать — сразу, показать — по Face ID (в приложении). */
export function BalancesEye() {
  const { masked } = useBalancesPrivacy();
  return (
    <IconButton
      icon={masked ? "eyeOff" : "eye"}
      label={masked ? "Показать суммы на счетах" : "Спрятать суммы на счетах"}
      variant="ghost"
      size={40}
      onClick={() => (masked ? void revealBalances() : hideBalances())}
    />
  );
}
