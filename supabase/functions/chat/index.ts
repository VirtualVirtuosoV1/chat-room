import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_ROOM = "pine-grove";
const MEMBER_STALE_MS = 45_000;
const DEFAULT_ROOM_CAPACITY = 5;
const MAX_ROOM_CAPACITY = 25;
const MAX_CLIENT_ID_LENGTH = 120;
const MAX_NAME_LENGTH = 80;
const MAX_NAME_SUFFIX_ATTEMPTS = 500;
const ROOM_ADJECTIVES = [
  "amber",
  "autumn",
  "cedar",
  "cloud",
  "crystal",
  "golden",
  "harbor",
  "lunar",
  "maple",
  "misty",
  "ocean",
  "pine",
  "quiet",
  "river",
  "silver",
  "stone",
  "sunny",
  "velvet",
  "wild",
  "willow",
];
const ROOM_NOUNS = [
  "bay",
  "bluff",
  "canyon",
  "commons",
  "cove",
  "creek",
  "forest",
  "garden",
  "grove",
  "harbor",
  "hollow",
  "lagoon",
  "meadow",
  "plaza",
  "ridge",
  "shore",
  "summit",
  "trail",
  "valley",
  "wharf",
];

type RequestBody = {
  action?: "list_mutes" | "mute" | "assign_room" | "touch_member" | "claim_name";
  room?: string;
  preferredRoom?: string;
  clientId?: string;
  roomCapacity?: number;
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

type MemberRow = {
  room: string;
  last_seen?: string;
};

type NameClaimRow = {
  name: string;
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
          "Database table is missing. Run migrations with `supabase db push` and retry.",
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

function normalizeRoom(rawRoom?: string | null): string {
  const trimmed = rawRoom?.trim().toLowerCase() ?? "";
  if (!trimmed) return DEFAULT_ROOM;

  const normalized = trimmed
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return DEFAULT_ROOM;
  return normalized.slice(0, 64);
}

function normalizeClientId(rawClientId?: string | null): string | null {
  const trimmed = rawClientId?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_CLIENT_ID_LENGTH);
}

function normalizeName(rawName?: string | null): string | null {
  const trimmed = rawName?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function nameCandidate(baseName: string, suffixIndex: number): string {
  if (suffixIndex <= 1) return baseName;

  const suffix = ` (${suffixIndex})`;
  const remaining = MAX_NAME_LENGTH - suffix.length;
  if (remaining <= 0) {
    return suffix.slice(0, MAX_NAME_LENGTH);
  }

  const clippedBase = baseName.slice(0, remaining).trimEnd();
  return `${clippedBase}${suffix}`;
}

function buildRoomNamePool(): string[] {
  const rooms: string[] = [];
  const seen = new Set<string>();

  const addRoom = (room: string) => {
    if (!room || seen.has(room)) return;
    seen.add(room);
    rooms.push(room);
  };

  addRoom(DEFAULT_ROOM);

  ROOM_ADJECTIVES.forEach((adjective) => {
    ROOM_NOUNS.forEach((noun) => {
      addRoom(`${adjective}-${noun}`);
    });
  });

  return rooms;
}

const ROOM_NAME_POOL = buildRoomNamePool();

function randomIndex(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % maxExclusive;
}

function pickAvailableRoom(counts: Record<string, number>, roomCapacity: number): string {
  if ((counts[DEFAULT_ROOM] ?? 0) < roomCapacity) {
    return DEFAULT_ROOM;
  }

  const partiallyFilled = Object.entries(counts)
    .filter(([roomName, count]) => roomName !== DEFAULT_ROOM && count > 0 && count < roomCapacity)
    .map(([roomName]) => roomName);

  if (partiallyFilled.length > 0) {
    return partiallyFilled[randomIndex(partiallyFilled.length)];
  }

  const unusedNamedRooms = ROOM_NAME_POOL.filter((roomName) => roomName !== DEFAULT_ROOM && !counts[roomName]);
  if (unusedNamedRooms.length > 0) {
    return unusedNamedRooms[randomIndex(unusedNamedRooms.length)];
  }

  const availableNamedRooms = ROOM_NAME_POOL.filter((roomName) => (counts[roomName] ?? 0) < roomCapacity);
  if (availableNamedRooms.length > 0) {
    return availableNamedRooms[randomIndex(availableNamedRooms.length)];
  }

  return `room-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000).toString(36)}`;
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
  const room = normalizeRoom(body.room);
  const nowIso = new Date().toISOString();
  const staleMemberCutoffIso = new Date(Date.now() - MEMBER_STALE_MS).toISOString();

  if (action === "list_mutes" || action === "mute") {
    const { error: cleanupError } = await supabase
      .from("chat_mutes")
      .delete()
      .eq("room", room)
      .lte("muted_until", nowIso);

    if (cleanupError) {
      return dbErrorResponse(cleanupError as DbError);
    }
  }

  if (action === "assign_room" || action === "touch_member" || action === "claim_name") {
    const { error: cleanupMembersError } = await supabase
      .from("chat_room_members")
      .delete()
      .lte("last_seen", staleMemberCutoffIso);

    if (cleanupMembersError) {
      return dbErrorResponse(cleanupMembersError as DbError);
    }

    const { error: cleanupClaimsError } = await supabase
      .from("chat_name_claims")
      .delete()
      .lte("last_seen", staleMemberCutoffIso);

    if (cleanupClaimsError) {
      return dbErrorResponse(cleanupClaimsError as DbError);
    }
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

  if (action === "assign_room") {
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return badRequest("clientId is required.");
    }

    const hasPreferredRoom = Boolean(body.preferredRoom?.trim());
    const preferredRoom = hasPreferredRoom ? normalizeRoom(body.preferredRoom) : null;
    const roomCapacity =
      typeof body.roomCapacity === "number" && Number.isInteger(body.roomCapacity) && body.roomCapacity > 0
        ? Math.min(body.roomCapacity, MAX_ROOM_CAPACITY)
        : DEFAULT_ROOM_CAPACITY;

    let assignedRoom: string;
    let assignment: "preferred" | "existing" | "auto";

    if (preferredRoom) {
      assignedRoom = preferredRoom;
      assignment = "preferred";
    } else {
      const { data: existingMember, error: existingMemberError } = await supabase
        .from("chat_room_members")
        .select("room,last_seen")
        .eq("client_id", clientId)
        .maybeSingle();

      if (existingMemberError) {
        return dbErrorResponse(existingMemberError as DbError);
      }

      const existing = existingMember as MemberRow | null;
      const existingLastSeen = existing?.last_seen ? new Date(existing.last_seen).getTime() : 0;
      if (existing?.room && existingLastSeen > Date.now() - MEMBER_STALE_MS) {
        assignedRoom = normalizeRoom(existing.room);
        assignment = "existing";
      } else {
        const { data: activeMembers, error: activeMembersError } = await supabase
          .from("chat_room_members")
          .select("room")
          .gt("last_seen", staleMemberCutoffIso);

        if (activeMembersError) {
          return dbErrorResponse(activeMembersError as DbError);
        }

        const countsByRoom: Record<string, number> = {};
        (activeMembers ?? []).forEach((member) => {
          const roomName = normalizeRoom((member as MemberRow).room);
          countsByRoom[roomName] = (countsByRoom[roomName] ?? 0) + 1;
        });

        assignedRoom = pickAvailableRoom(countsByRoom, roomCapacity);
        assignment = "auto";
      }
    }

    const { error: upsertMemberError } = await supabase.from("chat_room_members").upsert(
      {
        client_id: clientId,
        room: assignedRoom,
        last_seen: nowIso,
      },
      { onConflict: "client_id" },
    );

    if (upsertMemberError) {
      return dbErrorResponse(upsertMemberError as DbError);
    }

    const { error: clearOtherClaimsError } = await supabase
      .from("chat_name_claims")
      .delete()
      .eq("client_id", clientId)
      .neq("room", assignedRoom);

    if (clearOtherClaimsError) {
      return dbErrorResponse(clearOtherClaimsError as DbError);
    }

    const { count: activeCount, error: activeCountError } = await supabase
      .from("chat_room_members")
      .select("client_id", { count: "exact", head: true })
      .eq("room", assignedRoom)
      .gt("last_seen", staleMemberCutoffIso);

    if (activeCountError) {
      return dbErrorResponse(activeCountError as DbError);
    }

    return jsonResponse({
      room: assignedRoom,
      assignment,
      occupancy: activeCount ?? 1,
      capacity: roomCapacity,
    });
  }

  if (action === "touch_member") {
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return badRequest("clientId is required.");
    }
    const memberRoom = normalizeRoom(body.room);

    const { error: touchError } = await supabase.from("chat_room_members").upsert(
      {
        client_id: clientId,
        room: memberRoom,
        last_seen: nowIso,
      },
      { onConflict: "client_id" },
    );

    if (touchError) {
      return dbErrorResponse(touchError as DbError);
    }

    const { error: touchClaimError } = await supabase
      .from("chat_name_claims")
      .update({ last_seen: nowIso, updated_at: nowIso })
      .eq("room", memberRoom)
      .eq("client_id", clientId);

    if (touchClaimError) {
      return dbErrorResponse(touchClaimError as DbError);
    }

    const { error: clearOtherClaimsError } = await supabase
      .from("chat_name_claims")
      .delete()
      .eq("client_id", clientId)
      .neq("room", memberRoom);

    if (clearOtherClaimsError) {
      return dbErrorResponse(clearOtherClaimsError as DbError);
    }

    return jsonResponse({ ok: true, room: memberRoom });
  }

  if (action === "claim_name") {
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
      return badRequest("clientId is required.");
    }

    const baseName = normalizeName(body.name);
    if (!baseName) {
      return badRequest("name is required.");
    }

    const { error: upsertMemberError } = await supabase.from("chat_room_members").upsert(
      {
        client_id: clientId,
        room,
        last_seen: nowIso,
      },
      { onConflict: "client_id" },
    );

    if (upsertMemberError) {
      return dbErrorResponse(upsertMemberError as DbError);
    }

    const { error: clearOtherClaimsError } = await supabase
      .from("chat_name_claims")
      .delete()
      .eq("client_id", clientId)
      .neq("room", room);

    if (clearOtherClaimsError) {
      return dbErrorResponse(clearOtherClaimsError as DbError);
    }

    const { data: activeClaims, error: activeClaimsError } = await supabase
      .from("chat_name_claims")
      .select("name")
      .eq("room", room)
      .neq("client_id", clientId)
      .gt("last_seen", staleMemberCutoffIso);

    if (activeClaimsError) {
      return dbErrorResponse(activeClaimsError as DbError);
    }

    const takenNames = new Set<string>(
      ((activeClaims ?? []) as NameClaimRow[])
        .map((claim) => claim.name)
        .filter((claimName): claimName is string => Boolean(claimName)),
    );

    for (let suffixIndex = 1; suffixIndex <= MAX_NAME_SUFFIX_ATTEMPTS; suffixIndex += 1) {
      const candidate = nameCandidate(baseName, suffixIndex);
      if (takenNames.has(candidate)) {
        continue;
      }

      const { error: claimError } = await supabase.from("chat_name_claims").upsert(
        {
          room,
          client_id: clientId,
          name: candidate,
          last_seen: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "room,client_id" },
      );

      if (!claimError) {
        return jsonResponse({ ok: true, room, name: candidate });
      }

      if (claimError.code === "23505") {
        takenNames.add(candidate);
        continue;
      }

      return dbErrorResponse(claimError as DbError);
    }

    return jsonResponse({ error: "Unable to allocate a unique name in this room right now." }, 409);
  }

  if (action === "mute") {
    const name = normalizeName(body.name);
    if (!name) {
      return badRequest("name is required.");
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
