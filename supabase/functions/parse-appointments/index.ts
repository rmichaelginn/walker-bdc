// supabase/functions/parse-appointments/index.ts
//
// Accepts a POST with a base64-encoded PDF appointment report and a report_date,
// asks Claude (claude-sonnet-4-6) to extract per-customer appointment data from
// the PDF, inserts each extracted customer into the `appointments` table with
// `approved` left NULL (pending review), and returns the extracted rows as JSON.
//
// Environment:
//   ANTHROPIC_API_KEY           - Claude API key
//   SUPABASE_URL                - injected by the Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS for inserts)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The fields we extract per customer. Kept as one source of truth so the tool
// schema and the DB insert stay in sync.
const APPOINTMENT_FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "email",
  "vehicle_year",
  "vehicle_make",
  "vehicle_model",
  "vehicle_color",
  "mileage",
  "vin",
  "service_description",
  "advisor",
  "appt_type",
] as const;

type AppointmentField = (typeof APPOINTMENT_FIELDS)[number];
type Appointment = Partial<Record<AppointmentField, string>>;

// Tool schema Claude is forced to call. Every field is a string (or null when
// not present on the report) so the model never has to guess a type.
const appointmentItemSchema = {
  type: "object",
  properties: {
    first_name: { type: ["string", "null"], description: "Customer's first name." },
    last_name: { type: ["string", "null"], description: "Customer's last name." },
    phone: {
      type: ["string", "null"],
      description:
        "Customer phone number. Prefer the mobile/cell number when more than one is listed.",
    },
    email: { type: ["string", "null"], description: "Customer email address." },
    vehicle_year: { type: ["string", "null"], description: "Vehicle model year." },
    vehicle_make: { type: ["string", "null"], description: "Vehicle make, e.g. Ford." },
    vehicle_model: { type: ["string", "null"], description: "Vehicle model, e.g. F-150." },
    vehicle_color: { type: ["string", "null"], description: "Vehicle color." },
    mileage: { type: ["string", "null"], description: "Vehicle odometer / mileage." },
    vin: { type: ["string", "null"], description: "Vehicle Identification Number." },
    service_description: {
      type: ["string", "null"],
      description: "Description of the service / work to be performed.",
    },
    advisor: { type: ["string", "null"], description: "Service advisor name." },
    appt_type: {
      type: ["string", "null"],
      description: "Appointment type / category, e.g. Drop-off, Waiter, Express.",
    },
  },
  required: [...APPOINTMENT_FIELDS],
  additionalProperties: false,
};

const extractionTool = {
  name: "record_appointments",
  description:
    "Record every customer appointment found in the service-drive report. " +
    "Call this exactly once with one entry per customer appointment.",
  input_schema: {
    type: "object",
    properties: {
      appointments: {
        type: "array",
        description: "One entry per customer appointment in the report.",
        items: appointmentItemSchema,
      },
    },
    required: ["appointments"],
    additionalProperties: false,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function extractAppointments(
  pdfBase64: string,
  apiKey: string,
): Promise<Appointment[]> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      tools: [extractionTool],
      tool_choice: { type: "tool", name: "record_appointments" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            {
              type: "text",
              text:
                "This PDF is a dealership service-drive appointment report. " +
                "Extract every customer appointment listed and record them with the " +
                "record_appointments tool. Use one entry per appointment. When a customer " +
                "has both a mobile and a landline number, use the mobile number for `phone`. " +
                "If a field is not present for a given customer, set it to null. Do not " +
                "invent or guess values that are not in the document.",
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${detail}`);
  }

  const data = await res.json();

  // Forced tool_choice guarantees a tool_use block; find it and read its input.
  const toolUse = (data.content ?? []).find(
    (block: { type: string; name?: string }) =>
      block.type === "tool_use" && block.name === "record_appointments",
  );

  if (!toolUse) {
    throw new Error("Claude did not return a record_appointments tool call.");
  }

  const appointments = toolUse.input?.appointments;
  if (!Array.isArray(appointments)) {
    throw new Error("record_appointments tool call did not include an appointments array.");
  }

  return appointments as Appointment[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!anthropicKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured." }, 500);
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured." },
      500,
    );
  }

  // Parse and validate the request body.
  let payload: { pdf_base64?: string; report_date?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const pdfBase64 = payload.pdf_base64;
  const reportDate = payload.report_date;

  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return jsonResponse(
      { error: "Missing or invalid `pdf_base64` (base64-encoded PDF string)." },
      400,
    );
  }
  if (!reportDate || typeof reportDate !== "string") {
    return jsonResponse({ error: "Missing or invalid `report_date`." }, 400);
  }

  // Extract appointments from the PDF via Claude.
  let appointments: Appointment[];
  try {
    appointments = await extractAppointments(pdfBase64, anthropicKey);
  } catch (err) {
    return jsonResponse(
      { error: `Failed to extract appointments: ${(err as Error).message}` },
      502,
    );
  }

  // Insert each extracted customer as a pending (approved = NULL) appointment row.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const rows = appointments.map((appt) => {
    const row: Record<string, unknown> = { report_date: reportDate, approved: null };
    for (const field of APPOINTMENT_FIELDS) {
      row[field] = appt[field] ?? null;
    }
    return row;
  });

  if (rows.length === 0) {
    return jsonResponse({ report_date: reportDate, count: 0, appointments: [] });
  }

  const { data: inserted, error } = await supabase
    .from("appointments")
    .insert(rows)
    .select();

  if (error) {
    return jsonResponse(
      { error: `Failed to insert appointments: ${error.message}` },
      500,
    );
  }

  return jsonResponse({
    report_date: reportDate,
    count: inserted?.length ?? rows.length,
    appointments: inserted ?? rows,
  });
});
