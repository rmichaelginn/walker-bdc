// supabase/functions/send-messages/index.ts
//
// Accepts a POST in one of two modes:
//
//   1. Explicit: { "appointment_ids": [...] } — sends the listed appointments.
//   2. Auto:     { "auto": true } — ignores any appointment_ids and instead
//      queries the `appointments` table for every record that is approved, whose
//      scheduled send time has arrived (or is unset), and that has no existing
//      outbound message, then sends all of them.
//
// For each selected appointment it loads the customer record from the
// `appointments` table, builds a personalized SMS, sends it via the OpenPhone
// API to the customer's phone, and logs the outbound message to the `messages`
// table. Returns a summary of how many messages were sent.
//
// Environment:
//   OPENPHONE_API_KEY           - OpenPhone API key
//   OPENPHONE_NUMBER            - OpenPhone phone number to send from (E.164)
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS)

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENPHONE_API_URL = "https://api.openphone.com/v1/messages";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Appointment {
  id: number | string;
  first_name: string | null;
  vehicle_year: string | null;
  vehicle_model: string | null;
  phone: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Build the personalized outreach message. The template wording is fixed; only
// the bracketed fields are substituted.
function buildMessage(appt: Appointment): string {
  return (
    `Hey ${appt.first_name}, this is Rich at Walker Chevrolet. ` +
    `Saw your ${appt.vehicle_year} ${appt.vehicle_model} is in with us today ` +
    `and it's showing exchange eligible on our end. Are you looking to upgrade ` +
    `anytime soon? Happy to get some info for you while it's here. ` +
    `Reply STOP to opt out.`
  );
}

// Send a single SMS through OpenPhone. Returns the provider message id on
// success and throws on a non-2xx response so the caller can record the failure.
async function sendOpenPhoneMessage(
  apiKey: string,
  from: string,
  to: string,
  content: string,
): Promise<string | null> {
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

  const data = await res.json().catch(() => ({}));
  return data?.data?.id ?? null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const openphoneKey = Deno.env.get("OPENPHONE_API_KEY");
  const openphoneNumber = Deno.env.get("OPENPHONE_NUMBER");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!openphoneKey || !openphoneNumber) {
    return jsonResponse(
      { error: "OPENPHONE_API_KEY or OPENPHONE_NUMBER is not configured." },
      500,
    );
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured." },
      500,
    );
  }

  // Parse and validate the request body.
  let payload: { appointment_ids?: unknown; auto?: unknown };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  // In auto mode we ignore any supplied appointment_ids and discover the full
  // set of eligible appointments ourselves. Otherwise a non-empty array of IDs
  // is required.
  const auto = payload.auto === true;

  let ids: unknown[] = [];
  if (!auto) {
    const supplied = payload.appointment_ids;
    if (!Array.isArray(supplied) || supplied.length === 0) {
      return jsonResponse(
        {
          error:
            "Missing or invalid `appointment_ids` (non-empty array of IDs), or set `auto: true`.",
        },
        400,
      );
    }
    ids = supplied;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Load the eligible appointments. Only approved appointments whose scheduled
  // send time has arrived (or that have no scheduled time) are eligible —
  // anything scheduled for the future stays queued until NOW() passes it. In
  // explicit mode the set is further narrowed to the requested IDs; in auto mode
  // the full table is scanned. The "no existing outbound message" condition is
  // applied for auto mode below (and reinforced per-appointment by the
  // recent-contact dedup check in the loop).
  const nowIso = new Date().toISOString();
  let query = supabase
    .from("appointments")
    .select("id, first_name, vehicle_year, vehicle_model, phone")
    .eq("approved", true)
    .or(`scheduled_send_at.is.null,scheduled_send_at.lte.${nowIso}`);

  if (!auto) {
    query = query.in("id", ids);
  }

  const { data: appointments, error: fetchError } = await query;

  if (fetchError) {
    return jsonResponse(
      { error: `Failed to fetch appointments: ${fetchError.message}` },
      500,
    );
  }

  let found = (appointments ?? []) as Appointment[];

  // Auto mode: drop any appointment that already has an outbound message so we
  // only send to records that have never been contacted.
  if (auto && found.length > 0) {
    const { data: outbound, error: outboundError } = await supabase
      .from("messages")
      .select("appointment_id")
      .eq("direction", "outbound")
      .in("appointment_id", found.map((a) => a.id));

    if (outboundError) {
      return jsonResponse(
        {
          error: `Failed to check existing outbound messages: ${outboundError.message}`,
        },
        500,
      );
    }

    const alreadyMessaged = new Set(
      (outbound ?? []).map((m) => String(m.appointment_id)),
    );
    found = found.filter((a) => !alreadyMessaged.has(String(a.id)));
  }

  // Any outbound message newer than this cutoff counts as a recent contact.
  const ninetyDaysAgo = new Date(
    Date.now() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();

  let sent = 0;
  let skippedRecent = 0;
  const results: Array<{
    appointment_id: Appointment["id"];
    status: "sent" | "failed" | "skipped" | "skipped_recent_contact";
    error?: string;
  }> = [];

  for (const appt of found) {
    // Without a phone number there is nowhere to send the message.
    if (!appt.phone) {
      results.push({
        appointment_id: appt.id,
        status: "skipped",
        error: "No phone number on appointment.",
      });
      continue;
    }

    // Skip anyone we've already messaged in the last 90 days.
    const { data: recent, error: recentError } = await supabase
      .from("messages")
      .select("id")
      .eq("phone", appt.phone)
      .eq("direction", "outbound")
      .gte("sent_at", ninetyDaysAgo)
      .limit(1);

    if (recentError) {
      results.push({
        appointment_id: appt.id,
        status: "failed",
        error: `Failed to check recent contact: ${recentError.message}`,
      });
      continue;
    }

    if (recent && recent.length > 0) {
      results.push({
        appointment_id: appt.id,
        status: "skipped_recent_contact",
      });
      skippedRecent++;
      continue;
    }

    const content = buildMessage(appt);

    try {
      await sendOpenPhoneMessage(
        openphoneKey,
        openphoneNumber,
        appt.phone,
        content,
      );

      // Log the successfully sent message.
      const { error: logError } = await supabase.from("messages").insert({
        appointment_id: appt.id,
        phone: appt.phone,
        message_text: content,
        direction: "outbound",
        status: "sent",
      });

      if (logError) {
        // The message went out; surface the logging failure but still count it.
        results.push({
          appointment_id: appt.id,
          status: "sent",
          error: `Sent but failed to log: ${logError.message}`,
        });
      } else {
        results.push({ appointment_id: appt.id, status: "sent" });
      }
      sent++;
    } catch (err) {
      results.push({
        appointment_id: appt.id,
        status: "failed",
        error: (err as Error).message,
      });
    }
  }

  // Note any requested IDs that had no matching appointment row. Only relevant
  // in explicit mode — auto mode has no caller-supplied IDs to reconcile.
  if (!auto) {
    const foundIds = new Set(found.map((a) => String(a.id)));
    for (const id of ids) {
      if (!foundIds.has(String(id))) {
        results.push({
          appointment_id: id as Appointment["id"],
          status: "skipped",
          error: "Appointment not found.",
        });
      }
    }
  }

  return jsonResponse({
    mode: auto ? "auto" : "explicit",
    requested: auto ? found.length : ids.length,
    sent,
    skipped_recent_contact: skippedRecent,
    results,
  });
});
