// supabase/functions/weekly-brief/index.ts
//
// Accepts a POST (triggered manually or on a schedule) and builds the weekly
// summary for the Walker BDC texting program. It looks back over the past 7
// days of appointments and reports how many were parsed, texted vs. skipped,
// how many customers responded and how those replies were classified, plus how
// many converted. The summary is sent as a single SMS to ALERT_PHONE via the
// OpenPhone API. Returns 200 OK.
//
// The 7-day window is bounded by the dealership's local calendar day
// (America/Chicago) and matched against the appointments' `report_date`, so the
// brief always covers the right business week regardless of when it runs.
//
// Environment:
//   OPENPHONE_API_KEY           - OpenPhone API key
//   OPENPHONE_NUMBER            - OpenPhone phone number to send from (E.164)
//   ALERT_PHONE                 - phone number that receives the weekly brief
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS)

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENPHONE_API_URL = "https://api.openphone.com/v1/messages";

// Dealership-local timezone used to bound the weekly window.
const TIMEZONE = "America/Chicago";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Classification = "positive" | "negative" | "gray" | "unclear" | "processing";

interface AppointmentRow {
  id: number | string;
  approved: boolean | null;
  skipped_reason: string | null;
  converted: boolean | null;
}

interface ResponseRow {
  id: number | string;
  appointment_id: number | string | null;
  classification: Classification | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Current wall-clock date in `timeZone` as a YYYY-MM-DD string (en-CA format).
function todayLocalDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Add `days` (may be negative) to a YYYY-MM-DD date string, returning YYYY-MM-DD.
// Uses UTC arithmetic so it never shifts due to DST.
function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Human-friendly "Jun 13" rendering of a YYYY-MM-DD date string.
function formatMonthDay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
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

// Assemble the weekly brief text in the fixed format expected by the dealership.
function buildBrief(opts: {
  rangeLabel: string;
  parsed: number;
  texted: number;
  skipped: number;
  responded: number;
  responseRate: number;
  positive: number;
  negative: number;
  gray: number;
  converted: number;
  conversionRate: number;
}): string {
  const lines = [
    "WALKER BDC WEEKLY BRIEF",
    `Week of ${opts.rangeLabel}`,
    "",
    `Appointments parsed: ${opts.parsed}`,
    `Texted: ${opts.texted} | Skipped: ${opts.skipped}`,
    `Responded: ${opts.responded} (${opts.responseRate}%)`,
    `Positive: ${opts.positive} | Negative: ${opts.negative} | Gray: ${opts.gray}`,
    `Converted: ${opts.converted} (${opts.conversionRate}% of positive)`,
    "",
  ];

  if (opts.responded === 0) {
    lines.push("Quiet week — system is ready for Monday.");
  } else if (opts.conversionRate > 0) {
    lines.push("Nice work this week.");
  }

  return lines.join("\n").trimEnd();
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

  // Past 7 days, inclusive, bounded by report_date in dealership-local time.
  const endDate = todayLocalDate(TIMEZONE);
  const startDate = addDays(endDate, -6);
  const rangeLabel = `${formatMonthDay(startDate)} - ${formatMonthDay(endDate)}`;

  // 1. All appointments parsed in the window.
  const { data: apptData, error: apptError } = await supabase
    .from("appointments")
    .select("id, approved, skipped_reason, converted")
    .gte("report_date", startDate)
    .lte("report_date", endDate);

  if (apptError) {
    return jsonResponse(
      { error: `Failed to fetch appointments: ${apptError.message}` },
      500,
    );
  }

  const appointments = (apptData ?? []) as AppointmentRow[];

  // 2. Responses joined to this week's appointments.
  const apptIds = appointments.map((a) => a.id);
  let responses: ResponseRow[] = [];

  if (apptIds.length > 0) {
    const { data: responseData, error: responsesError } = await supabase
      .from("responses")
      .select("id, appointment_id, classification")
      .in("appointment_id", apptIds as Array<number | string>);

    if (responsesError) {
      return jsonResponse(
        { error: `Failed to fetch responses: ${responsesError.message}` },
        500,
      );
    }

    responses = (responseData ?? []) as ResponseRow[];
  }

  // 3. Aggregate the numbers.
  const parsed = appointments.length;
  const skipped = appointments.filter((a) => a.skipped_reason != null).length;
  const texted = appointments.filter(
    (a) => a.approved === true && a.skipped_reason == null,
  ).length;
  const converted = appointments.filter((a) => a.converted === true).length;

  const responded = responses.length;
  const positive = responses.filter((r) => r.classification === "positive").length;
  const negative = responses.filter((r) => r.classification === "negative").length;
  const gray = responses.filter((r) => r.classification === "gray").length;

  const responseRate = texted > 0 ? Math.round((responded / texted) * 100) : 0;
  const conversionRate =
    positive > 0 ? Math.round((converted / positive) * 100) : 0;

  // 4. Format and send the brief.
  const brief = buildBrief({
    rangeLabel,
    parsed,
    texted,
    skipped,
    responded,
    responseRate,
    positive,
    negative,
    gray,
    converted,
    conversionRate,
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
    summary: {
      range: rangeLabel,
      parsed,
      texted,
      skipped,
      responded,
      response_rate: responseRate,
      positive,
      negative,
      gray,
      converted,
      conversion_rate: conversionRate,
    },
    brief,
  });
});
