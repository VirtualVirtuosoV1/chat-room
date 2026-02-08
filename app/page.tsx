"use client";

import { useEffect, useRef, useState } from "react";
import { Space_Grotesk, Spectral } from "next/font/google";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";

const displayFont = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const bodyFont = Spectral({ subsets: ["latin"], weight: ["400", "500", "600"] });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

type Message = {
  id: string;
  author: string;
  content: string;
  timestamp: string;
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

export default function Home() {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const clientIdRef = useRef<string>("");
  const nameRef = useRef<string>("");
  const [name, setName] = useState<string>("");
  const [draftName, setDraftName] = useState<string>("");
  const [draftMessage, setDraftMessage] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [showNamePrompt, setShowNamePrompt] = useState<boolean>(true);
  const [connected, setConnected] = useState<string[]>([]);

  useEffect(() => {
    const storedName = typeof window !== "undefined" ? window.localStorage.getItem("chatroom-name") : null;
    if (storedName) {
      setName(storedName);
      setDraftName(storedName);
      setShowNamePrompt(false);
    }

    if (typeof window !== "undefined") {
      const storedClientId = window.localStorage.getItem("chatroom-client-id");
      if (storedClientId) {
        clientIdRef.current = storedClientId;
      } else {
        const nextId = randomId();
        clientIdRef.current = nextId;
        window.localStorage.setItem("chatroom-client-id", nextId);
      }
    }
  }, []);

  useEffect(() => {
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
    if (!supabase) return;

    const channel = supabase.channel("room:pine-grove", {
      config: {
        broadcast: { self: true },
        presence: { key: clientIdRef.current || randomId() },
      },
    });

    channelRef.current = channel;

    channel.on("broadcast", { event: "message" }, ({ payload }) => {
      const message = payload as Message;
      setMessages((prev) => [...prev, message]);
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, { name?: string }[]>;
      const names = new Set<string>();

      Object.values(state).forEach((entries) => {
        entries.forEach((entry) => {
          if (entry?.name) {
            names.add(entry.name);
          }
        });
      });

      setConnected(Array.from(names));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && nameRef.current) {
        channel.track({ name: nameRef.current });
      }
    });

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    nameRef.current = name;
    if (!name) return;
    channelRef.current?.track({ name });
  }, [name]);

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
    if (!trimmedMessage || !name) {
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
    <div className={`${displayFont.className} min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 text-slate-100`}>
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-10">
        <header className="mb-8 flex flex-col gap-3">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-400">Live room</p>
          <h1 className="text-4xl font-semibold">Studio Chatroom</h1>
          <p className={`${bodyFont.className} max-w-2xl text-lg text-slate-300`}>
            A lightweight space to exchange notes in real time. Pick a name to join the conversation.
          </p>
        </header>

        {!supabase && (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or
            NEXT_PUBLIC_SUPABASE_ANON_KEY).
          </div>
        )}

        <section className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex h-full flex-col rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-2xl shadow-slate-950/40">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-medium">Conversation</h2>
                <p className="text-sm text-slate-400">Room: Pine Grove</p>
              </div>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                {connected.length} online
              </span>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto pr-2">
              {messages.map((message) => (
                <div key={message.id} className="rounded-2xl bg-slate-900/60 p-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="font-semibold text-slate-200">{message.author}</span>
                    <span>{message.timestamp}</span>
                  </div>
                  <p className={`${bodyFont.className} mt-2 text-sm text-slate-200`}>{message.content}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              {!name && (
                <p className="mb-3 text-sm text-amber-200">
                  You need a display name before you can send messages.
                </p>
              )}
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  className="w-full rounded-full border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
                  placeholder={name ? "Type a message" : "Set a name to chat"}
                  value={draftMessage}
                  onChange={(event) => setDraftMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSend();
                    }
                  }}
                  disabled={!name || !supabase}
                />
                <button
                  className="rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  onClick={handleSend}
                  disabled={!name || !draftMessage.trim() || !supabase}
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
              <h3 className="text-lg font-semibold">Who&apos;s here</h3>
              <p className={`${bodyFont.className} mt-2 text-sm text-slate-400`}>
                Names currently connected to the room.
              </p>
              <ul className="mt-4 space-y-3 text-sm">
                {connected.map((person) => (
                  <li key={person} className="flex items-center justify-between rounded-full bg-slate-900/70 px-4 py-2">
                    <span>
                      {person}
                      {person === name ? " (you)" : ""}
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
            <div className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900/70 to-slate-950 p-6">
              <h3 className="text-lg font-semibold">Room rules</h3>
              <ul className={`${bodyFont.className} mt-3 space-y-2 text-sm text-slate-300`}>
                <li>Pick a display name to join.</li>
                <li>Messages are broadcast in real time.</li>
                <li>Be kind, clear, and concise.</li>
              </ul>
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
                className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
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
