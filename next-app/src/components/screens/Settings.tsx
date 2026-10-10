"use client";

import { AboutSection } from "./settings/AboutSection";
import { AccountSection } from "./settings/AccountSection";
import { AppleAiSection } from "./settings/AppleAiSection";
import { CategoriesSection } from "./settings/CategoriesSection";
import { DataSection } from "./settings/DataSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ProfileSection } from "./settings/ProfileSection";
import { SavingsSection } from "./settings/SavingsSection";
import { SmsImportSection } from "./settings/SmsImportSection";

export function Settings() {
  return (
    <div className="space-y-4">
      <AccountSection />
      <SmsImportSection />
      <AppleAiSection />
      <NotificationsSection />
      <SavingsSection />
      <CategoriesSection />
      <ProfileSection />
      <DataSection />
      <AboutSection />
    </div>
  );
}
