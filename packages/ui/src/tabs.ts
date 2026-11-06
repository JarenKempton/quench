import type { ComponentType } from "react";
import { HousekeepingView } from "./housekeeping-view.tsx";
import { OverviewPage } from "./overview-page.tsx";
import { SkillsPage } from "./skills-page.tsx";

export type Tab = { id: string; label: string; Page: ComponentType<{ params: URLSearchParams }> };

export const TABS: Tab[] = [
  { id: "overview", label: "Overview", Page: OverviewPage },
  { id: "skills", label: "Skills", Page: SkillsPage },
  { id: "housekeeping", label: "Housekeeping", Page: HousekeepingView },
];
