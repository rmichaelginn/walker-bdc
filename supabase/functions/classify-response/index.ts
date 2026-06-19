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

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function lastTen(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
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
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: `Classify this SMS reply as one word: positive, negative, gray, or unclear.\npositive = interested, curious, yes, sure, maybe\nnegative = not interested, happy with car, stop, no thanks\nunclear = gibberish, rude, hostile, profanity, emojis only, wrong number\ngray = vague or ambiguous\n\nMessage: "${message}"\n\nOne word only.` }]
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || "").toLowerCase().trim();
  if (text.includes("positive")) return "positive";
  if (text.includes("negative")) return "negative";
  if (text.includes("unclear")) return "unclear";
  return "gray";
}

async function generateReply(message: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: `You are Rich, Exchange Manager at Walker Chevrolet. A customer replied to your outreach text. Write a short casual human response matching their energy. 1-2 sentences max. No exclamation points unless they used one.\n\nReference responses:\n- sure/yes/interested: "I can get some options for you, are you in the service department now or did you drop off?"\n- what does exchange eligible mean: "We are looking for vehicles that have been serviced here and we may be able to help you exchange if you are looking to upgrade."\n- what would you offer: "I can get to work for you on that, is it here now?"\n- maybe/depends/not right now: "Got it, if you like I can get you an idea of estimated value so you at least have that info? Happy to help either way."\n- just bought this car: "Got it, appreciate you servicing with us today and being a part of the Walker family. Have a great one!"\n- already working with someone: "Perfect, who are you working with? I can let them know we spoke."\n- how does this work: "It is actually quick and easy, would love to put a face to the text. Are you here now or stopping in later?"\n\nCustomer message: "${message}"\n\nReply only with the text message. Nothing else.` }]
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || POSITIVE_REPLY_FALLBACK;
  } catch {
    return POSITIVE_REPLY_FALLBACK;
  }
}

async function processMessage(phone: string, message: string) {
  try {
    const normalized = lastTen(phone);
    const ourNormalized = lastTen(OPENPHONE_NUMBER);

    if (normalized === ourNormalized) {
      console.log("classify-response: skipping our own number");
      return;
    }

    const { data: sentMessages } = await supabase
      .from("messages")
      .select("id, phone")
      .eq("direction", "outbound");

    const weTextedFirst = (sentMessages || []).some((m: any) => lastTen(m.phone || "") === normalized);
    if (!weTextedFirst) {
      console.log(`classify-response: skipping ${normalized} — never texted them first`);
      return;
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentReplies } = await supabase
      .from("responses")
      .select("id, phone, classification")
      .gte("received_at", since24h);

    const alreadyReplied = (recentReplies || []).some((r: any) =>
      lastTen(r.phone || "") === normalized && r.classification !== "processing"
    );

    if (alreadyReplied) {
      console.log(`classify-response: skipping ${normalized} — already replied in last 24h`);
      return;
    }

    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase.from("responses").delete()
      .eq("phone", phone).eq("classification", "processing").lt("received_at", staleCutoff);

    const { data: lockRow, error: lockError } = await supabase
      .from("responses")
      .insert({ phone, response_text: message, classification: "processing", alert_sent: false })
      .select("id").single();

    if (lockError) {
      console.log(`classify-response: lock conflict for ${normalized}`);
      return;
    }

    const { data: appointments } = await supabase
      .from("appointments").select("id, first_name, phone").eq("approved", true);

    const appointment = (appointments || []).find((a: any) => lastTen(a.phone || "") === normalized);

    console.log(`classify-response: processing ${normalized} appointment=${appointment?.id || "none"}`);

    const classification = await classify(message);

    await supabase.from("responses")
      .update({ classification, appointment_id: appointment?.id || null })
      .eq("id", lockRow.id);

    if (classification === "unclear") {
      await sendText(ALERT_PHONE, `WALKER BDC: ${appointment?.first_name || "Customer"} sent an unusual message: '${message}'. Review and respond manually.`);
      await supabase.from("responses").update({ alert_sent: true }).eq("id", lockRow.id);
    } else if (classification === "negative") {
      await delay(45000);
      await sendText(phone, NEGATIVE_REPLY);
    } else {
      await delay(45000);
      const reply = await generateReply(message);
      await sendText(phone, reply);
      await sendText(ALERT_PHONE, `WALKER BDC: ${appointment?.first_name || "Customer"} responded ${classification}. Their message: '${message}'. Take over now.`);
      await supabase.from("responses").update({ alert_sent: true }).eq("id", lockRow.id);
    }

  } catch (err) {
    console.error("classify-response error:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const payload = await req.json();
    const eventType = payload?.type || "";
    if (eventType !== "message.received") return new Response("OK", { status: 200 });

    const phone = payload?.data?.object?.from || "";
    const message = payload?.data?.object?.body || payload?.data?.object?.text || "";

    if (!phone || !message) return new Response("OK", { status: 200 });

    EdgeRuntime.waitUntil(processMessage(phone, message));
    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("classify-response handler error:", err);
    return new Response("OK", { status: 200 });
  }
});
