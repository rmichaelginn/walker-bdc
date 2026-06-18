// supabase/functions/eod-brief/index.ts
//
// Accepts a POST (triggered manually or on a schedule) and builds the end-of-day
// summary for the Walker BDC texting program. It counts how many outreach
// messages went out today, how many customers replied and how those replies were
// classified, and lists the customers who responded positive/gray and still need
// a human to follow up. The summary is sent as a single SMS to ALERT_PHONE via
// the OpenPhone API. Returns 200 OK.
//
// "Today" is bounded by the dealership's local calendar day (America/Chicago),
// not UTC, so the brief covers the right business day regardless of when it runs.
//
// Environment:
//   OPENPHONE_API_KEY           - OpenPhone API key
//   OPENPHONE_NUMBER            - OpenPhone phone number to send from (E.164)
//   ALERT_PHONE                 - phone number that receives the EOD brief
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS)

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENPHONE_API_URL = "https://api.openphone.com/v1/messages";

// Dealership-local timezone used to bound the "today" window.
const TIMEZONE = "America/Chicago";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Classification = "positive" | "negative" | "gray";

interface ResponseRow {
  id: number | string;
  appointment_id: number | string | null;
  classification: Classification | null;
  message_text: string | null;
  alert_sent: boolean | null;
}

interface AppointmentRow {
  id: number | string;
  first_name: string | null;
  last_name: string | null;
  vehicle_year: string | null;
  vehicle_model: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Offset (in ms) between the given instant's UTC time and its wall-clock time in
// `timeZone`, such that wallClock = utc + offset. Negative for US timezones.
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // Interpret the wall-clock reading as if it were UTC, then compare.
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second,
  );
  return asUTC - date.getTime();
}

// UTC instant (ms) of local midnight for the given Y-M-D in `timeZone`. The
// offset is sampled at the same wall date, which is safe because DST changes
// happen at 02:00 rather than midnight.
function zonedMidnightUtcMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  // wallClock = utc + offset; we want wallClock = midnight => utc = guess - offset.
  return guess - offset;
}

// Return the [start, end) ISO timestamps that bound "today" for `timeZone`, so
// created_at filters select only rows from the current local calendar day.
function todayRange(timeZone: string): { start: string; end: string } {
  const now = new Date();

  // Current wall-clock date in the target timezone (en-CA formats as YYYY-MM-DD).
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, date] = day.split("-").map(Number);

  const startMs = zonedMidnightUtcMs(year, month, date, timeZone);

  // Start of tomorrow (local). Date.UTC handles month/year rollover; reading the
  // components back gives the next calendar day, then we resolve its local midnight.
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  const endMs = zonedMidnightUtcMs(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
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

// Assemble the EOD brief text in the fixed format expected by the dealership.
function buildBrief(opts: {
  sent: number;
  responded: number;
  rate: number;
  positive: number;
  negative: number;
  gray: number;
  needsAttention: Array<{
    firstName: string;
    lastName: string;
    vehicleYear: string;
    vehicleModel: string;
    message: string;
  }>;
}): string {
  const lines = [
    "WALKER BDC EOD BRIEF",
    `Sent: ${opts.sent}`,
    `Responded: ${opts.responded} (${opts.rate}%)`,
    `Positive: ${opts.positive} | Negative: ${opts.negative} | Gray: ${opts.gray}`,
    "",
    "Needs attention:",
  ];

  if (opts.needsAttention.length === 0) {
    lines.push("- None");
  } else {
    for (const c of opts.needsAttention) {
      const vehicle = [c.vehicleYear, c.vehicleModel].filter(Boolean).join(" ");
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
      lines.push(`- ${name} (${vehicle}): ${c.message}`);
    }
  }

  lines.push("", "Good work today.");
  return lines.join("\n");
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
  const alertPhone = Deno.env.get("ALERT_PHONE");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

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

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { start, end } = todayRange(TIMEZONE);

  // 1. Total outreach messages sent today (outbound only).
  const { count: sentCount, error: messagesError } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("created_at", start)
    .lt("created_at", end);

  if (messagesError) {
    return jsonResponse(
      { error: `Failed to count messages: ${messagesError.message}` },
      500,
    );
  }

  // 2. All responses received today.
  const { data: responseData, error: responsesError } = await supabase
    .from("responses")
    .select("id, appointment_id, classification, message_text, alert_sent")
    .gte("created_at", start)
    .lt("created_at", end);

  if (responsesError) {
    return jsonResponse(
      { error: `Failed to fetch responses: ${responsesError.message}` },
      500,
    );
  }

  const responses = (responseData ?? []) as ResponseRow[];

  // 3. Aggregate the response numbers.
  const sent = sentCount ?? 0;
  const responded = responses.length;
  const positive = responses.filter((r) => r.classification === "positive").length;
  const negative = responses.filter((r) => r.classification === "negative").length;
  const gray = responses.filter((r) => r.classification === "gray").length;
  const rate = sent > 0 ? Math.round((responded / sent) * 100) : 0;

  // 4. Customers who responded positive/gray and were already alerted to a human
  //    (alert_sent = true) but still need follow-up. Pull the matching approved
  //    appointments so we can show name + vehicle alongside their message.
  const attentionResponses = responses.filter(
    (r) =>
      r.alert_sent === true &&
      (r.classification === "positive" || r.classification === "gray") &&
      r.appointment_id != null,
  );

  const needsAttention: Array<{
    firstName: string;
    lastName: string;
    vehicleYear: string;
    vehicleModel: string;
    message: string;
  }> = [];

  if (attentionResponses.length > 0) {
    const apptIds = [...new Set(attentionResponses.map((r) => r.appointment_id))];

    const { data: apptData, error: apptError } = await supabase
      .from("appointments")
      .select("id, first_name, last_name, vehicle_year, vehicle_model")
      .in("id", apptIds as Array<number | string>)
      .eq("approved", true);

    if (apptError) {
      return jsonResponse(
        { error: `Failed to fetch appointments: ${apptError.message}` },
        500,
      );
    }

    const appts = (apptData ?? []) as AppointmentRow[];
    const apptById = new Map(appts.map((a) => [String(a.id), a]));

    for (const r of attentionResponses) {
      const appt = apptById.get(String(r.appointment_id));
      // Skip responses whose appointment isn't approved (not in the map).
      if (!appt) continue;
      needsAttention.push({
        firstName: appt.first_name ?? "",
        lastName: appt.last_name ?? "",
        vehicleYear: appt.vehicle_year ?? "",
        vehicleModel: appt.vehicle_model ?? "",
        message: r.message_text ?? "",
      });
    }
  }

  // 5. Format and send the brief.
  const brief = buildBrief({
    sent,
    responded,
    rate,
    positive,
    negative,
    gray,
    needsAttention,
  });

  try {
    await sendOpenPhoneMessage(openphoneKey, openphoneNumber, alertPhone, brief);
  } catch (err) {
    // The numbers are computed; surface the send failure but still return 200 so
    // a scheduled trigger doesn't retry and double-send.
    return jsonResponse({
      ok: true,
      sent_brief: false,
      warning: `Brief computed but failed to send: ${(err as Error).message}`,
      brief,
    });
  }

  return jsonResponse({
    ok: true,
    sent_brief: true,
    summary: { sent, responded, rate, positive, negative, gray },
    needs_attention: needsAttention.length,
    brief,
  });
});
