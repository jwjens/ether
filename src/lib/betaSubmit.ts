// betaSubmit.ts — how Settings → Beta Program & Feedback sends a form and reads the answer.
//
// The rule (item 10, docs/dead-items-10-18-19-2026-11-01.md): the screen says "received" ONLY when the backend
// answered 2xx with { ok: true }. Before this, the routes did not exist; every send 404'd, the screen silently opened a
// mail draft, said "the backend isn't reachable", and marked the application as filed anyway. Now a failure is shown as a
// failure, with its reason, and the form keeps what was typed. Emailing instead is offered as a button the user presses.

export type SubmitResult =
  | { ok: true; id: number | null }
  | { ok: false; kind: "invalid" | "rate" | "server" | "network" | "dev"; message: string };

const FIELD_WORDS: Record<string, string> = {
  station_name_required: "Station name is required.",
  contact_email_required: "Email is required.",
  contact_email_invalid: "That email address doesn't look right.",
  email_invalid: "That email address doesn't look right.",
  station_type_invalid: "Pick a station type.",
  category_invalid: "Pick a kind of feedback.",
  feedback_required: "Write something first.",
  why_ether_too_long: "\"Why Ether?\" is too long (5,000 characters at most).",
  feedback_too_long: "That's too long to send (10,000 characters at most).",
};

/** Plain words for a backend answer. Exported for the test. */
export function readAnswer(status: number, body: any): SubmitResult {
  if (status >= 200 && status < 300 && body && body.ok === true) {
    return { ok: true, id: Number.isInteger(body.id) ? body.id : null };
  }
  if (status === 400) {
    const fields: string[] = Array.isArray(body?.fields) ? body.fields : [];
    const words = fields.map(f => FIELD_WORDS[f] || (f.endsWith("_too_long") ? `${f.replace(/_too_long$/, "").replace(/_/g, " ")} is too long.` : `Check ${f.replace(/_(invalid|required)$/, "").replace(/_/g, " ")}.`));
    return { ok: false, kind: "invalid", message: words.length ? words.join(" ") : "The server didn't accept the form." };
  }
  if (status === 429) {
    return { ok: false, kind: "rate", message: "Too many sent from this network in the last 15 minutes. Not sent — try again later." };
  }
  if (status >= 200 && status < 300) {
    return { ok: false, kind: "server", message: "The server answered but didn't confirm it was saved. Not sent." };
  }
  return { ok: false, kind: "server", message: `The Ether server answered ${status}. Not sent.` };
}

/** POST the payload; never throws. */
export async function submitForm(url: string, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<SubmitResult> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach the Ether server (no internet, or it's down). Not sent." };
  }
  let body: any = null;
  try { body = await r.json(); } catch { body = null; }
  return readAnswer(r.status, body);
}

/** A mail draft with the same words, for the "Email it instead" button. */
export function mailtoFor(to: string, subject: string, lines: Record<string, unknown>): string {
  const body = Object.entries(lines).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
