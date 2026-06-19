import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENPHONE_API_KEY = Deno.env.get("OPENPHONE_API_KEY")!;
const OPENPHONE_NUMBER = Deno.env.get("OPENPHONE_NUMBER")!;
const ALERT_PHONE = Deno.env.get("ALERT_PHONE")!;

const NEGATIVE_REPLY = "Got it, appreciate you being part of the Walker family. Save my number and I'm here when you need me.";
const POSITIVE_REPLY_FALLBACK = "Ok great, I'll get to work for you.";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendText(to: string, message: string) {
  await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: { Authorization: OPENPHONE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: OPENPHONE_NUMBER, to: [to], content: message }),
  });
}

async function classify(message: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{
        role: "user",
        content: `Classify this text message response as exactly one word: positive, negative, gray, or unclear.\npositive = interested, curious, maybe, any engagement\nnegative = not interested, happy with car, stop, no thanks\ngray = vague, ambiguous\nunclear = gibberish, emojis only, or a single character; appears to be a wrong number or accidental text; in a foreign language we can't interpret; rude, hostile, aggressive, or uses profanity\n\nMessage: "${message}"\n\nRespond with one word only.`
      }]
    }),
  });
  const data = await res.json();
  const text = data.content?.[0]?.text?.toLowerCase().trim() || "gray";
  if (text.includes("positive")) return "positive";
  if (text.includes("negative")) return "negative";
  if (text.includes("unclear")) return "unclear";
  return "gray";
}

async function generateReply(message: string): Promise<string> {
  const prompt = `You are Rich, Exchange Manager at Walker Chevrolet. A customer just replied to your outreach text. Generate a short, casual, human response that matches their energy. One to two sentences max. No exclamation points unless they used one. Sound like a real person texting, not a salesperson.

Use these as reference responses for similar situations:
- If they say sure/yes/interested: 'I can get some options for you, are you in the service department now or did you drop off?'
- If they ask what exchange eligible means: 'We are looking for vehicles that have been serviced here and we may be able to help you exchange if you are looking to upgrade.'
- If they ask what you would offer: 'I can get to work for you on that, is it here now?'
- If they say maybe/depends/not right now: 'Got it, if you like I can get you an idea of estimated value so you at least have that info? Happy to help either way.'
- If they just bought the car: 'Got it, appreciate you servicing with us today and being a part of the Walker family. Have a great one!'
- If already working with someone: 'Perfect, who are you working with? I can let them know we spoke.'
- If they ask how it works: 'It is actually quick and easy, would love to put a face to the text. Are you here now or stopping in later?'

Customer message: '${message}'

Reply only with the text message response. Nothing else.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || POSITIVE_REPLY_FALLBACK;
}

async function processMessage(phone: string, message: string) {
  try {
    // The inbound webhook sends phone as E.164 (+19316741400) but our messages
    // table stores it as 10 digits (9316741400). Normalize both sides to the
    // last 10 digits before comparing so the dedup/eligibility checks match.
    const digits = phone.replace(/\D/g, "").slice(-10);
    const matchesPhone = (p: string | null) =>
      (p || "").replace(/\D/g, "").slice(-10) === digits;

    // Bug fix 1: don't auto-reply more than once per conversation. If we already
    // logged a response for this phone in the last 24h, we've already replied — skip.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentResponses } = await supabase
      .from("responses")
      .select("phone")
      .gte("created_at", cutoff);
    const alreadyReplied = (recentResponses || []).some((r: any) =>
      matchesPhone(r.phone));

    // Bug fix 2: only respond to people we texted first. If there's no outbound
    // message to this phone in our system, skip.
    const { data: outbound } = await supabase
      .from("messages")
      .select("phone")
      .eq("direction", "outbound");
    const weTextedFirst = (outbound || []).some((m: any) =>
      matchesPhone(m.phone));

    console.log(
      `classify-response: processMessage phone=${phone} normalized=${digits} ` +
        `recentReplyCheck=${alreadyReplied ? "FAIL(already replied in 24h)" : "PASS"} ` +
        `textedFirstCheck=${weTextedFirst ? "PASS" : "FAIL(no prior outbound)"}`
    );

    if (alreadyReplied) {
      console.log("classify-response: already replied to this number in last 24h, skipping");
      return;
    }

    if (!weTextedFirst) {
      console.log("classify-response: no prior outbound message to this number, skipping");
      return;
    }

    const { data: appointments } = await supabase
      .from("appointments")
      .select("id, first_name, phone")
      .eq("approved", true);

    const appointment = (appointments || []).find((a: any) => matchesPhone(a.phone));

    // Stale lock self-healing. If a previous handler crashed after claiming the
    // lock but before promoting it, the 'processing' row would block this number
    // forever. Clear any 'processing' row older than 5 minutes (far longer than
    // a normal 45s handler) so a crashed run heals automatically and we proceed.
    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase
      .from("responses")
      .delete()
      .eq("phone", phone)
      .eq("classification", "processing")
      .lt("created_at", staleCutoff);

    // Atomic dedup lock. Claim this number by inserting a placeholder
    // "processing" row up front, before the 45s human-delay window. A partial
    // unique index on responses(phone) WHERE classification = 'processing'
    // (see migration 20260619201701_responses_processing_lock.sql) means a
    // second webhook that fires during the delay hits a unique-constraint
    // violation here and bails — only one handler per number ever replies.
    const { data: lockRow, error: lockError } = await supabase
      .from("responses")
      .insert({
        appointment_id: appointment?.id || null,
        phone,
        message_text: message,
        classification: "processing",
        alert_sent: false,
      })
      .select("id")
      .single();

    if (lockError || !lockRow) {
      console.log(
        `classify-response: could not acquire processing lock for ${phone} ` +
          `(another webhook already handling this message), skipping`,
        lockError?.message ?? ""
      );
      return;
    }

    const classification = await classify(message);

    // Promote the placeholder lock row to its real classification. This releases
    // the 'processing' lock while leaving a row that the 24h recent-reply check
    // will see, blocking any duplicate webhooks that arrive after this point.
    await supabase
      .from("responses")
      .update({ classification, appointment_id: appointment?.id || null })
      .eq("id", lockRow.id);

    if (classification === "unclear") {
      // Don't reply to unusual messages — alert the team to handle it manually, immediately (no delay).
      await sendText(ALERT_PHONE, `WALKER BDC: ${appointment?.first_name || "Customer"} sent an unusual message: '${message}'. Review and respond manually.`);
      await supabase.from("responses").update({ alert_sent: true }).eq("id", lockRow.id);
    } else if (classification === "negative") {
      // Wait before replying to the customer so the response feels human.
      await delay(45000);
      await sendText(phone, NEGATIVE_REPLY);
    } else {
      // Wait before replying to the customer so the response feels human.
      await delay(45000);
      const reply = await generateReply(message);
      await sendText(phone, reply);
      await sendText(ALERT_PHONE, `WALKER BDC: ${appointment?.first_name || "Customer"} responded ${classification}. Their message: '${message}'. Take over now.`);
      await supabase.from("responses").update({ alert_sent: true }).eq("id", lockRow.id);
    }
  } catch (err) {
    console.error("classify-response background error:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const payload = await req.json();

    // Only process inbound messages — ignore everything else to prevent the outbound message loop.
    if (payload?.type !== "message.received") return new Response("OK", { status: 200 });

    const direction = payload?.data?.object?.direction || payload?.direction || "";
    if (direction === "outbound") return new Response("OK", { status: 200 });
    const phone = payload?.data?.object?.from || payload?.from || "";
    const message = payload?.data?.object?.body || payload?.data?.object?.text || payload?.body || payload?.text || "";

    if (!phone || !message) return new Response("OK", { status: 200 });

    // Secondary loop prevention — ignore any message that came from our own OpenPhone number.
    const fromDigits = phone.replace(/\D/g, "").slice(-10);
    const ourDigits = OPENPHONE_NUMBER.replace(/\D/g, "").slice(-10);
    if (fromDigits === ourDigits) return new Response("OK", { status: 200 });

    // Respond 200 OK immediately, then do the classify + 45s delay + reply work in the
    // background. This prevents OpenPhone from retrying the webhook while we wait.
    EdgeRuntime.waitUntil(processMessage(phone, message));

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("classify-response error:", err);
    return new Response("OK", { status: 200 });
  }
});
