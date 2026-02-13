import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RequestBody = {
  action?: "list_mutes" | "mute";
  room?: string;
  name?: string;
  mutedUntil?: number;
};

type MuteRow = {
  room: string;
  name: string;
  muted_until: string;
};

type DbError = {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function dbErrorResponse(error: DbError): Response {
  if (error.code === "42P01") {
    return jsonResponse(
      {
        error:
          "Database table public.chat_mutes is missing. Run the migration (supabase db push) and retry.",
        code: error.code,
      },
      500,
    );
  }

  return jsonResponse(
    {
      error: error.message,
      code: error.code,
      hint: error.hint ?? undefined,
      details: error.details ?? undefined,
    },
    500,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const action = body.action ?? "list_mutes";
  const room = body.room?.trim() || "pine-grove";
  const nowIso = new Date().toISOString();

  const { error: cleanupError } = await supabase
    .from("chat_mutes")
    .delete()
    .eq("room", room)
    .lte("muted_until", nowIso);

  if (cleanupError) {
    return dbErrorResponse(cleanupError as DbError);
  }

  if (action === "list_mutes") {
    const { data, error } = await supabase
      .from("chat_mutes")
      .select("room,name,muted_until")
      .eq("room", room)
      .gt("muted_until", nowIso)
      .order("muted_until", { ascending: true });

    if (error) {
      return dbErrorResponse(error as DbError);
    }

    const mutes = ((data ?? []) as MuteRow[]).map((entry) => ({
      room: entry.room,
      name: entry.name,
      mutedUntil: new Date(entry.muted_until).getTime(),
    }));

    return jsonResponse({ mutes });
  }

  if (action === "mute") {
    const name = body.name?.trim();
    if (!name) {
      return badRequest("name is required.");
    }
    if (name.length > 80) {
      return badRequest("name is too long.");
    }
    if (typeof body.mutedUntil !== "number" || !Number.isFinite(body.mutedUntil)) {
      return badRequest("mutedUntil must be a valid timestamp in milliseconds.");
    }

    const mutedUntilDate = new Date(body.mutedUntil);
    if (Number.isNaN(mutedUntilDate.getTime())) {
      return badRequest("mutedUntil must be a valid date.");
    }
    if (mutedUntilDate.getTime() <= Date.now()) {
      return badRequest("mutedUntil must be in the future.");
    }

    const { error } = await supabase.from("chat_mutes").upsert(
      {
        room,
        name,
        muted_until: mutedUntilDate.toISOString(),
        updated_at: nowIso,
      },
      { onConflict: "room,name" },
    );

    if (error) {
      return dbErrorResponse(error as DbError);
    }

    return jsonResponse({
      ok: true,
      mute: {
        room,
        name,
        mutedUntil: mutedUntilDate.getTime(),
      },
    });
  }

  return badRequest("Unsupported action.");
});
