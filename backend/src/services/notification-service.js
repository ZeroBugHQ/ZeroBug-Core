import nodemailer from "nodemailer";
import { config } from "../config.js";

function buildTransporter() {
  if (!config.smtpHost || !config.smtpFrom) return null;
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function artifactLinks(artifacts) {
  return (artifacts ?? [])
    .map((artifact) => `- ${artifact.label}: ${artifact.url}`)
    .join("\n");
}

/**
 * Build a Slack Block Kit payload. Produces a rich, color-coded message with
 * test details, artifact links, and an optional "New failure" banner.
 */
function buildSlackPayload({ projectName, test, run, newFailure }) {
  const passed = run.status === "passed";
  const statusEmoji = passed ? "✅" : "❌";
  const color = passed ? "#22c55e" : "#ef4444";

  const fields = [
    { type: "mrkdwn", text: `*Project*\n${projectName}` },
    { type: "mrkdwn", text: `*Test*\n${test.code} — ${test.title}` },
    { type: "mrkdwn", text: `*Mode*\n${run.mode || "ui"}` },
    { type: "mrkdwn", text: `*Attempts*\n${run.attempt}/${run.maxAttempts}` },
  ];

  if (run.failureReason) {
    fields.push({ type: "mrkdwn", text: `*Failure*\n\`${run.failureReason}\`` });
  }
  if (run.output?.url) {
    fields.push({ type: "mrkdwn", text: `*URL*\n${run.output.url}` });
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${statusEmoji} ${newFailure ? "New failure: " : ""}${test.code} ${passed ? "passed" : "failed"}`,
        emoji: true,
      },
    },
    { type: "section", fields },
  ];

  if (run.artifacts?.length) {
    const links = run.artifacts
      .map((artifact) => `<${artifact.url}|${artifact.label}>`)
      .join("  ·  ");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Artifacts*\n${links}` },
    });
  }

  blocks.push({ type: "divider" });

  return {
    // Fallback text for notifications/previews.
    text: `${statusEmoji} ${test.code} ${run.status} (${projectName})`,
    attachments: [{ color, blocks }],
  };
}

/** Send an alert when a project breaches its pass-rate / critical-fail thresholds. */
export async function notifyThresholdBreach({ projectName, passRate, threshold, criticalFailures = [] }) {
  const reasons = [];
  if (threshold > 0 && typeof passRate === "number" && passRate < threshold) {
    reasons.push(`Pass rate ${passRate}% is below the ${threshold}% threshold`);
  }
  if (criticalFailures.length) {
    reasons.push(`${criticalFailures.length} critical test(s) failed: ${criticalFailures.join(", ")}`);
  }
  if (!reasons.length) return { attempted: false };

  const transporter = buildTransporter();
  const recipients = config.notifyEmails;
  const webhookUrls = config.notifyWebhookUrls;
  const subject = `[ZeroBug] ⚠ Alert: ${projectName}`;
  const text = `Project: ${projectName}\n${reasons.join("\n")}`;
  const slack = {
    text: `⚠ *ZeroBug alert — ${projectName}*\n${reasons.map((r) => `• ${r}`).join("\n")}`,
  };
  const generic = { event: "alert", projectName, passRate, threshold, criticalFailures, reasons };

  const results = await Promise.allSettled([
    ...(transporter && recipients.length
      ? [transporter.sendMail({ from: config.smtpFrom, to: recipients.join(", "), subject, text })]
      : []),
    ...webhookUrls.map((url) => {
      const isSlack = /hooks\.slack\.com\/services\//i.test(url);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSlack ? slack : generic),
      });
    }),
  ]);

  return { attempted: results.length > 0, sent: results.some((r) => r.status === "fulfilled"), reasons };
}

export async function notifyRunCompletion({ projectName, test, run, previousStatus }) {
  const transporter = buildTransporter();
  const recipients = config.notifyEmails;
  const webhookUrls = config.notifyWebhookUrls;
  const newFailure = run.status === "failed" && previousStatus !== "failed";

  const subject = `[ZeroBug] ${run.status === "passed" ? "Passed" : "Failed"}: ${test.code} ${test.title}`;
  const summary = [
    `Project: ${projectName}`,
    `Test: ${test.code} — ${test.title}`,
    `Mode: ${run.mode}`,
    `Status: ${run.status}`,
    `Attempts: ${run.attempt}/${run.maxAttempts}`,
    run.failureReason ? `Failure: ${run.failureReason}` : "",
    run.output?.url ? `URL: ${run.output.url}` : "",
    run.artifacts?.length ? `Artifacts:\n${artifactLinks(run.artifacts)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <h2>ZeroBug run ${htmlEscape(run.status)}</h2>
    <p><strong>Project:</strong> ${htmlEscape(projectName)}</p>
    <p><strong>Test:</strong> ${htmlEscape(test.code)} — ${htmlEscape(test.title)}</p>
    <p><strong>Mode:</strong> ${htmlEscape(run.mode)}</p>
    <p><strong>Attempts:</strong> ${htmlEscape(run.attempt)}/${htmlEscape(run.maxAttempts)}</p>
    ${run.failureReason ? `<p><strong>Failure:</strong> ${htmlEscape(run.failureReason)}</p>` : ""}
    ${run.artifacts?.length ? `<ul>${run.artifacts.map((artifact) => `<li><a href="${htmlEscape(artifact.url)}">${htmlEscape(artifact.label)}</a></li>`).join("")}</ul>` : ""}
  `;

  // Detect whether each webhook URL is a Slack incoming webhook by its path
  // pattern (/services/T.../B.../...) and use Block Kit for those; fall back to
  // a plain JSON body for generic webhooks.
  const slackPayload = buildSlackPayload({ projectName, test, run, newFailure });
  const genericPayload = {
    event: newFailure ? "new_failure" : "run_completed",
    projectName,
    test,
    run,
    previousStatus,
  };

  const results = await Promise.allSettled([
    ...(transporter && recipients.length
      ? [
          transporter.sendMail({
            from: config.smtpFrom,
            to: recipients.join(", "),
            subject,
            text: summary,
            html,
          }),
        ]
      : []),
    ...webhookUrls.map((url) => {
      const isSlack =
        /hooks\.slack\.com\/services\//i.test(url) ||
        /slack\.com\/.*\/incoming-webhooks\//i.test(url);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSlack ? slackPayload : genericPayload),
      });
    }),
  ]);

  return {
    attempted: results.length > 0,
    sent: results.some((result) => result.status === "fulfilled"),
    newFailure,
    errors: results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason)),
  };
}
