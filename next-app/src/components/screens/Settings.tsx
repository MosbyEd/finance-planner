"use client";

import { AboutSection } from "./settings/AboutSection";
import { AccountSection } from "./settings/AccountSection";
import { CategoriesSection } from "./settings/CategoriesSection";
import { DataSection } from "./settings/DataSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ProfileSection } from "./settings/ProfileSection";
import { SavingsSection } from "./settings/SavingsSection";

export function Settings() {
  return (
    <div className="space-y-4">
      <AccountSection />
      <NotificationsSection />
      <SavingsSection />
      <CategoriesSection />
      <ProfileSection />
      <DataSection />
      <AboutSection />
    </div>
  );
}
