import { SkillsView } from "./skills-view.tsx";
import type { Harness, SkillsReport } from "./skills.ts";
import { Loaded, Message } from "./use-api.tsx";

export function SkillsPage({ params }: { params: URLSearchParams }) {
  const agent = params.get("agent");
  return (
    <Loaded<SkillsReport> path="/api/skills" what="your skills">
      {(report) =>
        report.skills.length ? (
          <SkillsView key={agent} report={report} agent={agent as Harness | null} />
        ) : (
          <Message title="No skills found">
            None of your agents have skills on disk, and no session in the last {report.days} days
            listed one. Add a skill, or run quench ui --days 90.
          </Message>
        )
      }
    </Loaded>
  );
}
