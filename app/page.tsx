"use client";

import { useEffect, useRef, useState } from "react";
import { Space_Grotesk, Spectral } from "next/font/google";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";

const displayFont = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const bodyFont = Spectral({ subsets: ["latin"], weight: ["400", "500", "600"] });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const DEFAULT_ROOM = "pine-grove";
const ROOM_CAPACITY = 5;

type Message = {
  id: string;
  author: string;
  content: string;
  timestamp: string;
};

type MutePayload = {
  name: string;
  mutedUntil: number;
  room?: string;
};

type ActiveMutesResponse = {
  mutes?: MutePayload[];
};

type RoomAssignmentResponse = {
  room?: string;
  assignment?: "preferred" | "existing" | "auto";
  occupancy?: number;
  capacity?: number;
};

type ConnectedUser = {
  id: string;
  name: string;
  displayName: string;
  isSelf: boolean;
};

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function randomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function roomLabelFromSlug(room: string | null): string {
  if (!room) return "Assigning room…";
  return room
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function preferredRoomFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room")?.trim();
  return room || undefined;
}

function writeRoomToUrl(room: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("room") === room) return;
  url.searchParams.set("room", room);
  window.history.replaceState(null, "", url.toString());
}

async function formatFunctionInvokeError(error: unknown, response?: Response): Promise<string> {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (!response) {
    return baseMessage;
  }

  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  try {
    const rawBody = await response.clone().text();
    if (!rawBody) {
      return `${baseMessage} (HTTP ${status})`;
    }

    try {
      const parsed = JSON.parse(rawBody) as { error?: string };
      if (parsed?.error) {
        return `${baseMessage} (HTTP ${status}): ${parsed.error}`;
      }
    } catch {
      // Fallback to raw text body.
    }

    return `${baseMessage} (HTTP ${status}): ${rawBody}`;
  } catch {
    return `${baseMessage} (HTTP ${status})`;
  }
}

export default function Home() {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const clientIdRef = useRef<string>("");
  const nameRef = useRef<string>("");
  const roomRef = useRef<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [name, setName] = useState<string>("");
  const [draftName, setDraftName] = useState<string>("");
  const [draftMessage, setDraftMessage] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [showNamePrompt, setShowNamePrompt] = useState<boolean>(true);
  const [clientId, setClientId] = useState<string>("");
  const [room, setRoom] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectedUser[]>([]);
  const [isSubscribed, setIsSubscribed] = useState<boolean>(false);
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [mutedUsers, setMutedUsers] = useState<Record<string, number>>({});
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [now, setNow] = useState<number>(() => Date.now());
  const sendTimestampsRef = useRef<number[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const loadMutedUsers = async () => {
    if (!supabase || !roomRef.current) return;

    const { data, error, response } = await supabase.functions.invoke<ActiveMutesResponse>("chat", {
      body: {
        action: "list_mutes",
        room: roomRef.current,
      },
    });

    if (error) {
      const details = await formatFunctionInvokeError(error, response);
      console.error("Failed to load muted users:", details);
      return;
    }

    const currentTime = Date.now();
    const activeMutes: Record<string, number> = {};
    (data?.mutes ?? []).forEach((entry) => {
      if (!entry?.name || !entry?.mutedUntil || currentTime >= entry.mutedUntil) return;
      activeMutes[entry.name] = entry.mutedUntil;
    });

    setMutedUsers((prev) => ({ ...prev, ...activeMutes }));

    const selfMuteUntil = nameRef.current ? activeMutes[nameRef.current] : undefined;
    if (selfMuteUntil && currentTime < selfMuteUntil) {
      setCooldownUntil(selfMuteUntil);
    }
  };

  const persistMute = async (payload: MutePayload) => {
    if (!supabase || !roomRef.current) return;

    const { error, response } = await supabase.functions.invoke("chat", {
      body: {
        action: "mute",
        room: payload.room ?? roomRef.current,
        name: payload.name,
        mutedUntil: payload.mutedUntil,
      },
    });

    if (error) {
      const details = await formatFunctionInvokeError(error, response);
      console.error("Failed to persist mute:", details);
    }
  };

  const assignRoom = async (activeClientId: string) => {
    if (!supabase) return;

    const preferredRoom = preferredRoomFromUrl();
    const { data, error, response } = await supabase.functions.invoke<RoomAssignmentResponse>("chat", {
      body: {
        action: "assign_room",
        clientId: activeClientId,
        preferredRoom,
        roomCapacity: ROOM_CAPACITY,
      },
    });

    if (error) {
      const details = await formatFunctionInvokeError(error, response);
      console.error("Failed to assign room:", details);

      const fallbackRoom = preferredRoom ?? DEFAULT_ROOM;
      roomRef.current = fallbackRoom;
      setRoom(fallbackRoom);
      writeRoomToUrl(fallbackRoom);
      return;
    }

    const assignedRoom = data?.room ?? preferredRoom ?? DEFAULT_ROOM;
    roomRef.current = assignedRoom;
    setRoom(assignedRoom);
    writeRoomToUrl(assignedRoom);
  };

  const touchRoomMember = async () => {
    if (!supabase || !roomRef.current || !clientIdRef.current) return;

    const { error, response } = await supabase.functions.invoke("chat", {
      body: {
        action: "touch_member",
        clientId: clientIdRef.current,
        room: roomRef.current,
      },
    });

    if (error) {
      const details = await formatFunctionInvokeError(error, response);
      console.error("Failed to refresh room membership:", details);
    }
  };

  const setCopyStatusForMoment = (status: "copied" | "error") => {
    setCopyStatus(status);
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyStatus("idle");
      copyResetTimerRef.current = null;
    }, 2_200);
  };

  const handleCopyRoomLink = async () => {
    if (!room || typeof window === "undefined") return;
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("room", room);
    const link = shareUrl.toString();

    try {
      await navigator.clipboard.writeText(link);
      setCopyStatusForMoment("copied");
      return;
    } catch {
      // Fall back to a hidden textarea for browsers that block Clipboard API.
    }

    try {
      const fallbackInput = document.createElement("textarea");
      fallbackInput.value = link;
      fallbackInput.setAttribute("readonly", "true");
      fallbackInput.style.position = "absolute";
      fallbackInput.style.left = "-9999px";
      document.body.appendChild(fallbackInput);
      fallbackInput.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(fallbackInput);
      setCopyStatusForMoment(copied ? "copied" : "error");
    } catch {
      setCopyStatusForMoment("error");
    }
  };

  useEffect(() => {
    const storedName = typeof window !== "undefined" ? window.localStorage.getItem("chatroom-name") : null;
    if (storedName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(storedName);
      setDraftName(storedName);
      setShowNamePrompt(false);
    }

    if (typeof window !== "undefined") {
      const storedClientId = window.localStorage.getItem("chatroom-client-id");
      if (storedClientId) {
        clientIdRef.current = storedClientId;
        setClientId(storedClientId);
      } else {
        const nextId = randomId();
        clientIdRef.current = nextId;
        setClientId(nextId);
        window.localStorage.setItem("chatroom-client-id", nextId);
      }

      const handleStorage = (event: StorageEvent) => {
        if (event.key !== "chatroom-name") return;
        if (event.newValue) {
          setName(event.newValue);
          setDraftName(event.newValue);
          setShowNamePrompt(false);
        } else {
          setName("");
          setDraftName("");
          setShowNamePrompt(true);
        }
      };

      window.addEventListener("storage", handleStorage);
      return () => window.removeEventListener("storage", handleStorage);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!supabase || !clientId) return;

    let cancelled = false;
    const run = async () => {
      await assignRoom(clientId);
      if (!cancelled) {
        void touchRoomMember();
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([
      {
        id: "welcome",
        author: "System",
        content: "Welcome to the room. Pick a name to join the chat.",
        timestamp: timestamp(),
      },
    ]);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!room || !clientId) return;
    roomRef.current = room;

    void touchRoomMember();
    const interval = window.setInterval(() => {
      void touchRoomMember();
    }, 20_000);

    return () => window.clearInterval(interval);
  }, [room, clientId]);

  useEffect(() => {
    if (!room) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMutedUsers({});
    setCooldownUntil(null);
  }, [room]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const canSend = Boolean(
    name &&
      room &&
      supabase &&
      isSubscribed &&
      isJoined &&
      !(cooldownUntil !== null && now < cooldownUntil)
  );

  useEffect(() => {
    if (!supabase || !room || !clientId) return;

    const channel = supabase.channel(`room:${room}`, {
      config: {
        broadcast: { self: true },
        presence: { key: clientId },
      },
    });

    channelRef.current = channel;

    channel.on("broadcast", { event: "message" }, ({ payload }) => {
      const message = payload as Message;
      setMessages((prev) => [...prev, message]);
    });

    channel.on("broadcast", { event: "mute" }, ({ payload }) => {
      const data = payload as MutePayload;
      if (!data?.name || !data?.mutedUntil) return;
      if (data.room && data.room !== room) return;
      setMutedUsers((prev) => ({ ...prev, [data.name]: data.mutedUntil }));
      if (data.name === nameRef.current && Date.now() < data.mutedUntil) {
        setCooldownUntil(data.mutedUntil);
      }
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, { name?: string }[]>;
      const users: Array<{ id: string; name: string; isSelf: boolean }> = [];

      Object.entries(state).forEach(([presenceKey, entries]) => {
        entries.forEach((entry, index) => {
          const trimmedName = entry?.name?.trim();
          if (!trimmedName) return;
          users.push({
            id: `${presenceKey}-${index}`,
            name: trimmedName,
            isSelf: presenceKey === clientIdRef.current,
          });
        });
      });

      users.sort((a, b) => {
        const nameComparison = a.name.localeCompare(b.name);
        if (nameComparison !== 0) return nameComparison;
        return a.id.localeCompare(b.id);
      });

      const countsByName: Record<string, number> = {};
      const labelledUsers: ConnectedUser[] = users.map((user) => {
        const seen = (countsByName[user.name] ?? 0) + 1;
        countsByName[user.name] = seen;
        return {
          id: user.id,
          name: user.name,
          displayName: seen === 1 ? user.name : `${user.name} (${seen})`,
          isSelf: user.isSelf,
        };
      });

      setConnected(labelledUsers);
      setIsJoined(labelledUsers.some((user) => user.isSelf));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setIsSubscribed(true);
        void loadMutedUsers();
        if (nameRef.current) {
          channel.track({ name: nameRef.current });
        }
        return;
      }
      if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
        setIsSubscribed(false);
        setIsJoined(false);
      }
    });

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsSubscribed(false);
      setIsJoined(false);
    };
  }, [room, clientId]);

  useEffect(() => {
    nameRef.current = name;
    if (!name) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsJoined(false);
      return;
    }
    if (isSubscribed) {
      channelRef.current?.track({ name });
    }
  }, [name, isSubscribed]);

  const broadcastSystemMessage = (content: string) => {
    if (!channelRef.current) return;
    channelRef.current.send({
      type: "broadcast",
      event: "message",
      payload: {
        id: `system-${Date.now()}`,
        author: "System",
        content,
        timestamp: timestamp(),
      },
    });
  };

  const handleJoin = () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      return;
    }
    setName(trimmed);
    window.localStorage.setItem("chatroom-name", trimmed);
    setShowNamePrompt(false);
    channelRef.current?.track({ name: trimmed });
    broadcastSystemMessage(`${trimmed} joined the room.`);
  };

  const handleSend = () => {
    const trimmedMessage = draftMessage.trim();
    if (!trimmedMessage || !canSend) {
      return;
    }
    const currentTime = Date.now();

    const windowMs = 10_000;
    const maxMessages = 6;
    sendTimestampsRef.current = sendTimestampsRef.current.filter((stamp) => currentTime - stamp < windowMs);
    sendTimestampsRef.current.push(currentTime);
    if (sendTimestampsRef.current.length > maxMessages) {
      const mutedUntil = currentTime + 60_000;
      const mutePayload: MutePayload = { name, mutedUntil, room: room ?? DEFAULT_ROOM };
      setCooldownUntil(mutedUntil);
      setMutedUsers((prev) => ({ ...prev, [name]: mutedUntil }));
      void persistMute(mutePayload);
      channelRef.current?.send({
        type: "broadcast",
        event: "mute",
        payload: mutePayload,
      });
      broadcastSystemMessage(`${name} was muted for 1 minute due to spam.`);
      return;
    }
    channelRef.current?.send({
      type: "broadcast",
      event: "message",
      payload: {
        id: `msg-${Date.now()}`,
        author: name,
        content: trimmedMessage,
        timestamp: timestamp(),
      },
    });
    setDraftMessage("");
  };

  return (
    <div className={`${displayFont.className} min-h-screen overflow-x-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-slate-100 lg:h-screen lg:overflow-hidden`}>
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8 lg:h-full lg:min-h-0 lg:py-10">
        <header className="mb-5 flex flex-col gap-3 sm:mb-6">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">Live room</p>
          <h1 className="text-3xl font-semibold sm:text-4xl">Chatroom</h1>
          <p className={`${bodyFont.className} max-w-2xl text-base text-slate-300 sm:text-lg`}>
            A lightweight space to exchange notes in real time. Pick a name to join the conversation.
          </p>
        </header>

        {!supabase && (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or
            NEXT_PUBLIC_SUPABASE_ANON_KEY).
          </div>
        )}

        <section className="grid gap-6 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-4 shadow-2xl shadow-slate-950/40 sm:p-6 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-medium">Conversation</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-slate-400">Room: {roomLabelFromSlug(room)}</span>
                  <button
                    className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs font-medium text-slate-200 transition hover:border-emerald-400 hover:text-emerald-200 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                    onClick={handleCopyRoomLink}
                    disabled={!room}
                  >
                    Copy link
                  </button>
                  {copyStatus === "copied" && <span className="text-xs text-emerald-300">Copied</span>}
                  {copyStatus === "error" && <span className="text-xs text-rose-300">Copy failed</span>}
                </div>
              </div>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                {connected.length} online
              </span>
            </div>

            <div className="max-h-[44vh] space-y-4 overflow-y-auto pr-1 sm:pr-2 lg:max-h-none lg:min-h-0 lg:flex-1">
              {messages.map((message) => (
                <div key={message.id} className="rounded-2xl bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="font-semibold text-slate-200">{message.author}</span>
                    <span>{message.timestamp}</span>
                  </div>
                  <p className={`${bodyFont.className} mt-2 text-sm text-slate-200`}>{message.content}</p>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              {!name && (
                <p className="mb-3 text-sm text-amber-200">
                  You need a display name before you can send messages.
                </p>
              )}
              {!room && (
                <p className="mb-3 text-sm text-amber-200">Assigning you to a room…</p>
              )}
              {name && !isSubscribed && (
                <p className="mb-3 text-sm text-amber-200">Connecting to chat…</p>
              )}
              {name && isSubscribed && !isJoined && (
                <p className="mb-3 text-sm text-amber-200">
                  Rejoining the room… If this persists, refresh the page.
                </p>
              )}
              {cooldownUntil && now < cooldownUntil && (
                <p className="mb-3 text-sm text-rose-200">
                  You are muted for {Math.ceil((cooldownUntil - now) / 1000)} seconds.
                </p>
              )}
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  className="w-full rounded-full border border-slate-700 bg-slate-950/60 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  placeholder={name ? "Type a message" : "Set a name to chat"}
                  value={draftMessage}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setDraftMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSend();
                    }
                  }}
                  disabled={!canSend}
                />
                <button
                  className="rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  onClick={handleSend}
                  disabled={!draftMessage.trim() || !canSend}
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6 lg:min-h-0 lg:overflow-hidden">
            <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-4 sm:p-6">
              <h3 className="text-lg font-semibold">Who&apos;s here</h3>
              <ul className="mt-4 space-y-3 text-sm">
                {connected.map((person) => (
                  <li key={person.id} className="flex items-center justify-between rounded-full bg-slate-900/70 px-4 py-2">
                    <span>
                      {person.displayName}
                      {person.isSelf ? " (you)" : ""}
                    </span>
                    <span className="text-emerald-300">●</span>
                  </li>
                ))}
                {connected.length === 0 && (
                  <li className="rounded-2xl bg-slate-900/70 px-4 py-3 text-slate-400">
                    No one else yet.
                  </li>
                )}
              </ul>
            </div>
            <div className="space-y-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1">
              <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-4 sm:p-6">
                <h3 className="text-lg font-semibold">Muted</h3>
                <p className={`${bodyFont.className} mt-2 text-sm text-slate-400`}>
                  Users currently rate-limited for spam.
                </p>
                <ul className="mt-4 space-y-3 text-sm">
                  {Object.entries(mutedUsers)
                    .filter(([, until]) => now < until)
                    .sort((a, b) => a[1] - b[1])
                    .map(([person, until]) => (
                      <li key={person} className="flex items-center justify-between rounded-full bg-slate-900/70 px-4 py-2">
                        <span>{person}</span>
                        <span className="text-rose-300">
                          {Math.ceil((until - now) / 1000)}s
                        </span>
                      </li>
                    ))}
                  {Object.values(mutedUsers).filter((until) => now < until).length === 0 && (
                    <li className="rounded-2xl bg-slate-900/70 px-4 py-3 text-slate-400">
                      No one is muted.
                    </li>
                  )}
                </ul>
              </div>
              <div className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900/70 to-slate-950 p-4 sm:p-6">
                <h3 className="text-lg font-semibold">Room rules</h3>
                <ul className={`${bodyFont.className} mt-3 space-y-2 text-sm text-slate-300`}>
                  <li>Pick a display name to join.</li>
                  <li>Messages are broadcast in real time.</li>
                  <li>Be kind, clear, and concise.</li>
                  <li>Spamming messages may result in a temporary mute.</li>
                  <li>There is a soft limit of 5 users per room. You can bypass this limit by joining with a room&apos;s link.</li>
                </ul>
              </div>
            </div>
          </aside>
        </section>
      </div>

      {showNamePrompt && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/80 px-6">
          <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-950 p-8 shadow-2xl">
            <h2 className="text-2xl font-semibold">Choose your name</h2>
            <p className={`${bodyFont.className} mt-2 text-sm text-slate-400`}>
              This will appear in the chat for everyone in the room.
            </p>
            <div className="mt-6 flex flex-col gap-4">
              <input
                className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                placeholder="e.g. Taylor"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleJoin();
                  }
                }}
              />
              <button
                className="rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                onClick={handleJoin}
                disabled={!draftName.trim() || !supabase}
              >
                Join room
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
