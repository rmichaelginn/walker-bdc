// supabase/functions/walker-bdc-mcp/index.ts
//
// MCP (Model Context Protocol) server for the Walker BDC texting program. It
// exposes the BDC workflow — parse an appointment report, review/approve the
// pending appointments, fire the outreach campaign, read the day's replies, and
// send the EOD brief — as MCP tools an assistant can call.
//
// Built with the two-Hono-apps pattern (as in Cipher's cipher-mcp function): an
// outer Hono app owns the function path prefix and the ?key= auth gate, and an
// inner Hono app serves the MCP StreamableHTTP transport. The outer app routes
// the inner one under the function name so the request path lines up with how
// Supabase mounts the function.
//
// Auth: every request must carry ?key=<WALKER_BDC_MCP_KEY>.
//
// Environment:
//   WALKER_BDC_MCP_KEY          - shared secret required on the ?key= query param
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS, calls functions)

import { Hono } from "jsr:@hono/hono";
import { StreamableHTTPTransport } from "jsr:@hono/mcp";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "npm:zod";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Dealership-local timezone used to bound the "today" windows, matching the
// eod-brief function so every part of the program agrees on the business day.
const TIMEZONE = "America/Chicago";

const FUNCTION_NAME = "walker-bdc-mcp";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MCP_KEY = Deno.env.get("WALKER_BDC_MCP_KEY") ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function supabaseClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// Wrap a JS value as an MCP text-content tool result.
function textResult(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

// Wrap an error message as an MCP error tool result.
function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// Call a sibling edge function by name with the service-role key.
async function callFunction(
  name: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`${name} returned ${res.status}: ${text}`);
  }
  return parsed;
}

// --- "today" window math (mirrors eod-brief) ------------------------------

// Offset (in ms) between an instant's UTC time and its wall-clock time in
// `timeZone`, such that wallClock = utc + offset.
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

// UTC instant (ms) of local midnight for the given Y-M-D in `timeZone`.
function zonedMidnightUtcMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  return guess - offset;
}

// Local calendar date (YYYY-MM-DD) for `timeZone` right now.
function todayLocalDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// [start, end) ISO timestamps bounding "today" in `timeZone`.
function todayRange(timeZone: string): { start: string; end: string } {
  const [year, month, date] = todayLocalDate(timeZone).split("-").map(Number);
  const startMs = zonedMidnightUtcMs(year, month, date, timeZone);
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

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({
    name: "walker-bdc-mcp",
    version: "1.0.0",
  });

  // 1. parse_appointments — extract appointments from a PDF report.
  server.tool(
    "parse_appointments",
    "Parse a dealership service-drive appointment report. Accepts a " +
      "base64-encoded PDF and the report date, runs extraction, inserts the " +
      "appointments as pending (approved = NULL), and returns the extracted list.",
    {
      pdf_base64: z.string().describe("Base64-encoded PDF of the appointment report."),
      report_date: z.string().describe("The report date, e.g. 2026-06-18."),
    },
    async ({ pdf_base64, report_date }) => {
      try {
        const result = await callFunction("parse-appointments", {
          pdf_base64,
          report_date,
        });
        return textResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 2. get_pending_approvals — today's appointments awaiting review.
  server.tool(
    "get_pending_approvals",
    "List today's appointments that are still pending review (approved IS NULL).",
    {},
    async () => {
      try {
        const supabase = supabaseClient();
        const { data, error } = await supabase
          .from("appointments")
          .select(
            "id, first_name, last_name, vehicle_year, vehicle_model, mileage, phone, service_description",
          )
          .is("approved", null)
          .eq("report_date", todayLocalDate(TIMEZONE))
          .order("id", { ascending: true });

        if (error) return errorResult(`Failed to fetch pending approvals: ${error.message}`);
        return textResult({ count: data?.length ?? 0, appointments: data ?? [] });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 3. approve_appointments — mark a set of appointments approved.
  server.tool(
    "approve_appointments",
    "Approve appointments by ID (sets approved = true).",
    {
      appointment_ids: z
        .array(z.union([z.number(), z.string()]))
        .min(1)
        .describe("IDs of the appointments to approve."),
    },
    async ({ appointment_ids }) => {
      try {
        const supabase = supabaseClient();
        const { data, error } = await supabase
          .from("appointments")
          .update({ approved: true })
          .in("id", appointment_ids)
          .select("id");

        if (error) return errorResult(`Failed to approve appointments: ${error.message}`);
        return textResult({
          approved: data?.map((r) => r.id) ?? [],
          count: data?.length ?? 0,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 4. deny_appointments — mark a set of appointments denied.
  server.tool(
    "deny_appointments",
    "Deny appointments by ID (sets approved = false).",
    {
      appointment_ids: z
        .array(z.union([z.number(), z.string()]))
        .min(1)
        .describe("IDs of the appointments to deny."),
    },
    async ({ appointment_ids }) => {
      try {
        const supabase = supabaseClient();
        const { data, error } = await supabase
          .from("appointments")
          .update({ approved: false })
          .in("id", appointment_ids)
          .select("id");

        if (error) return errorResult(`Failed to deny appointments: ${error.message}`);
        return textResult({
          denied: data?.map((r) => r.id) ?? [],
          count: data?.length ?? 0,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 5. send_campaign — text every approved appointment not yet contacted.
  server.tool(
    "send_campaign",
    "Send the outreach campaign to all approved appointments that have not yet " +
      "received an outbound message, via the send-messages function.",
    {},
    async () => {
      try {
        const supabase = supabaseClient();

        // All approved appointments.
        const { data: approved, error: apptError } = await supabase
          .from("appointments")
          .select("id")
          .eq("approved", true);

        if (apptError) return errorResult(`Failed to fetch approved appointments: ${apptError.message}`);

        const approvedIds = (approved ?? []).map((a) => a.id);
        if (approvedIds.length === 0) {
          return textResult({ requested: 0, message: "No approved appointments." });
        }

        // Appointment IDs that already have an outbound message logged.
        const { data: sentMsgs, error: msgError } = await supabase
          .from("messages")
          .select("appointment_id")
          .eq("direction", "outbound")
          .in("appointment_id", approvedIds);

        if (msgError) return errorResult(`Failed to fetch existing messages: ${msgError.message}`);

        const alreadySent = new Set((sentMsgs ?? []).map((m) => String(m.appointment_id)));
        const targetIds = approvedIds.filter((id) => !alreadySent.has(String(id)));

        if (targetIds.length === 0) {
          return textResult({
            requested: 0,
            message: "All approved appointments have already been contacted.",
          });
        }

        const result = await callFunction("send-messages", {
          appointment_ids: targetIds,
        });
        return textResult({ targeted: targetIds, result });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 6. get_todays_responses — today's replies with customer/vehicle context.
  server.tool(
    "get_todays_responses",
    "List today's customer responses joined to their appointment, with name, " +
      "vehicle, classification, and the reply text.",
    {},
    async () => {
      try {
        const supabase = supabaseClient();
        const { start, end } = todayRange(TIMEZONE);

        const { data: responses, error: respError } = await supabase
          .from("responses")
          .select("appointment_id, classification, message_text")
          .gte("created_at", start)
          .lt("created_at", end)
          .order("created_at", { ascending: true });

        if (respError) return errorResult(`Failed to fetch responses: ${respError.message}`);

        const rows = responses ?? [];
        const apptIds = [
          ...new Set(rows.map((r) => r.appointment_id).filter((id) => id != null)),
        ];

        // Pull the matching appointments so we can attach name + vehicle.
        let apptById = new Map<string, Record<string, unknown>>();
        if (apptIds.length > 0) {
          const { data: appts, error: apptError } = await supabase
            .from("appointments")
            .select("id, first_name, last_name, vehicle_year, vehicle_model")
            .in("id", apptIds as Array<number | string>);

          if (apptError) return errorResult(`Failed to fetch appointments: ${apptError.message}`);
          apptById = new Map((appts ?? []).map((a) => [String(a.id), a]));
        }

        const result = rows.map((r) => {
          const appt = r.appointment_id != null ? apptById.get(String(r.appointment_id)) : undefined;
          return {
            first_name: appt?.first_name ?? null,
            last_name: appt?.last_name ?? null,
            vehicle_year: appt?.vehicle_year ?? null,
            vehicle_model: appt?.vehicle_model ?? null,
            classification: r.classification,
            message_text: r.message_text,
          };
        });

        return textResult({ count: result.length, responses: result });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // 7. send_eod_brief — trigger the end-of-day summary text.
  server.tool(
    "send_eod_brief",
    "Trigger the end-of-day brief, which texts the EOD summary to ALERT_PHONE.",
    {},
    async () => {
      try {
        const result = await callFunction("eod-brief", {});
        return textResult(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Two Hono apps: inner serves the MCP transport, outer gates auth + path.
// ---------------------------------------------------------------------------

const mcpApp = new Hono();

mcpApp.all("/", async (c) => {
  const transport = new StreamableHTTPTransport();
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const app = new Hono();

// ?key= auth gate on every request to this function.
app.use("*", async (c, next) => {
  if (!MCP_KEY) {
    return c.json({ error: "WALKER_BDC_MCP_KEY is not configured." }, 500);
  }
  if (c.req.query("key") !== MCP_KEY) {
    return c.json({ error: "Unauthorized." }, 401);
  }
  await next();
});

// Supabase mounts the function under its name; route the MCP app there.
app.route(`/${FUNCTION_NAME}`, mcpApp);

Deno.serve(app.fetch);
