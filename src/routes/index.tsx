import { createFileRoute } from "@tanstack/react-router";
import { TestRunnerApp } from "@/components/test-runner-app";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ZeroBug — AI-powered Playwright test runner" },
      {
        name: "description",
        content:
          "Queue, execute and triage end-to-end tests on a kanban board with an AI agent driving Playwright in real time.",
      },
      { property: "og:title", content: "ZeroBug — AI-powered Playwright test runner" },
      {
        property: "og:description",
        content:
          "Queue, execute and triage end-to-end tests on a kanban board with an AI agent driving Playwright in real time.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return <TestRunnerApp />;
}
