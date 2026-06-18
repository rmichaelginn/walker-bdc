// supabase/functions/classify-response/index.ts
//
// Called by an OpenPhone webhook whenever a customer replies to an outreach text.
// It extracts the customer's phone number and message from the webhook payload,
// finds the matching appointment, asks Claude (claude-sonnet-4-6) to classify the
// reply as "positive", "negative", or "gray", records the reply in the
// `responses` table with that classification, and then either alerts a human
// (positive / gray) or auto-replies with a polite close-out (negative).
//
// Environment:
//   ANTHROPIC_API_KEY           - Claude API key
//   OPENPHONE_API_KEY           - OpenPhone API key
//   OPENPHONE_NUMBER            - OpenPhone phone number to send from (E.164)
//   ALERT_PHONE                 - phone number that receives takeover alerts
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENPHONE_API_URL = "https://api.openphone.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// Polite, relationship-preserving auto-reply sent when a customer is not interested.
const NEGATIVE_REPLY =
  "Got it, appreciate you being part of the Walker family. " +
  "Save my number and I'm here when you need me.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Classification = "positive" | "negative" | "gray";

// Tool Claude is forced to call so we always get back exactly one of the three
// labels instead of free-form prose.
const classifyTool = {
  name: "record_classification",
  description:
    "Record the classification of a customer's text-message reply to a " +
    "vehicle-upgrade outreach. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: ["positive", "negative", "gray"],
        description:
          "positive = interested, curious, maybe, or any engagement that is not a " +
          "clear no. negative = not interested, happy with their current car, asks " +
          "to stop, or says no thanks. gray = vague, ambiguous, or unclear intent.",
      },
    },
    required: ["classification"],
    additionalProperties: false,
  },
};

interface Appointment {
  id: number | string;
  first_name: string | null;
  phone: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Keep only the digits of a phone number so numbers that differ only by
// formatting (spaces, dashes, "+1", parens) still match between OpenPhone and
// whatever was stored on the appointment row.
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // Drop a leading US country code so "+15551234567" and "5551234567" match.
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// Pull the customer's phone number and message text out of the OpenPhone webhook
// payload. OpenPhone nests the event under data.object; for an inbound message
// the customer is `from` and the body is `text` (with `body` as a fallback).
function extractInbound(
  payload: unknown,
): { phone: string; message: string } | null {
  const obj =
    (payload as { data?: { object?: Record<string, unknown> } })?.data?.object ??
    (payload as Record<string, unknown>);

  if (!obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;
  const phone = record.from;
  const message = record.text ?? record.body;

  if (typeof phone !== "string" || typeof message !== "string") return null;
  if (!phone.trim() || !message.trim()) return null;

  return { phone, message };
}

async function classifyMessage(
  message: string,
  apiKey: string,
): Promise<Classification> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [classifyTool],
      tool_choice: { type: "tool", name: "record_classification" },
      messages: [
        {
          role: "user",
          content:
            "A customer at a car dealership received a text asking if they were " +
            "interested in upgrading their vehicle. Classify their reply below using " +
            "the record_classification tool.\n\n" +
            `Customer reply: "${message}"`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${detail}`);
  }

  const data = await res.json();

  const toolUse = (data.content ?? []).find(
    (block: { type: string; name?: string }) =>
      block.type === "tool_use" && block.name === "record_classification",
  );

  const classification = toolUse?.input?.classification;
  if (
    classification !== "positive" &&
    classification !== "negative" &&
    classification !== "gray"
  ) {
    throw new Error("Claude did not return a valid classification.");
  }

  return classification;
}

// Send a single SMS through OpenPhone.
async function sendOpenPhoneMessage(
  apiKey: string,
  from: string,
  to: string,
  content: string,
): Promise<void> {
  const res = await fetch(OPENPHONE_API_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], content }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenPhone API error ${res.status}: ${detail}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const openphoneKey = Deno.env.get("OPENPHONE_API_KEY");
  const openphoneNumber = Deno.env.get("OPENPHONE_NUMBER");
  const alertPhone = Deno.env.get("ALERT_PHONE");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured." }, 500);
  }
  if (!openphoneKey || !openphoneNumber || !alertPhone) {
    return jsonResponse(
      { error: "OPENPHONE_API_KEY, OPENPHONE_NUMBER, or ALERT_PHONE is not configured." },
      500,
    );
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured." },
      500,
    );
  }

  // Parse the webhook payload.
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const inbound = extractInbound(payload);
  if (!inbound) {
    return jsonResponse(
      { error: "Could not extract phone number and message from webhook payload." },
      400,
    );
  }
  const { phone, message } = inbound;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Look up the matching appointment by phone number. Phone formats can differ
  // between systems, so match on the normalized (digits-only) suffix.
  const normalized = normalizePhone(phone);
  const { data: appointments, error: fetchError } = await supabase
    .from("appointments")
    .select("id, first_name, phone")
    .ilike("phone", `%${normalized.slice(-10)}%`);

  if (fetchError) {
    return jsonResponse(
      { error: `Failed to look up appointment: ${fetchError.message}` },
      500,
    );
  }

  // Prefer an exact normalized match; fall back to the first loose match.
  const matches = (appointments ?? []) as Appointment[];
  const appointment =
    matches.find((a) => a.phone && normalizePhone(a.phone) === normalized) ??
    matches[0] ??
    null;

  // Classify the reply with Claude.
  let classification: Classification;
  try {
    classification = await classifyMessage(message, anthropicKey);
  } catch (err) {
    return jsonResponse(
      { error: `Failed to classify response: ${(err as Error).message}` },
      502,
    );
  }

  // Record the response with its classification.
  const { error: insertError } = await supabase.from("responses").insert({
    appointment_id: appointment?.id ?? null,
    phone,
    message_text: message,
    classification,
  });

  if (insertError) {
    return jsonResponse(
      { error: `Failed to record response: ${insertError.message}` },
      500,
    );
  }

  const firstName = appointment?.first_name ?? "Customer";

  // Act on the classification.
  try {
    if (classification === "negative") {
      // Politely close the loop with the customer; no human handoff needed.
      await sendOpenPhoneMessage(openphoneKey, openphoneNumber, phone, NEGATIVE_REPLY);
    } else {
      // positive or gray -> alert a human to take over the conversation.
      const alert =
        `WALKER BDC: ${firstName} responded ${classification}. ` +
        `Their message: '${message}'. Take over now.`;
      await sendOpenPhoneMessage(openphoneKey, openphoneNumber, alertPhone, alert);
    }
  } catch (err) {
    // The response is already recorded; surface the send failure but don't lose
    // the classification work. Still return 200 so OpenPhone doesn't retry the
    // webhook and re-run the classification.
    return jsonResponse({
      ok: true,
      classification,
      appointment_id: appointment?.id ?? null,
      warning: `Classified and recorded, but follow-up send failed: ${(err as Error).message}`,
    });
  }

  return jsonResponse({
    ok: true,
    classification,
    appointment_id: appointment?.id ?? null,
  });
});
