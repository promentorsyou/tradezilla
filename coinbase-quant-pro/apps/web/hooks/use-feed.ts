"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
export type Feed = {
  status: string;
  price?: number;
  time?: string;
  source?: string;
  received?: number;
};
export function useFeed(product: string): Feed {
  const [feed, setFeed] = useState<Feed>({ status: "CONNECTING" });
  const client = useQueryClient();
  useEffect(() => {
    let stopped = false,
      socket: WebSocket,
      retry = 0,
      heartbeat = 0,
      ticker = 0;
    let timer: ReturnType<typeof setTimeout>;
    setFeed({ status: "CONNECTING" });
    const connect = () => {
      socket = new WebSocket(
        API.replace(/^http/, "ws") +
          "/ws/markets?product=" +
          encodeURIComponent(product),
      );
      socket.onopen = () => {
        client.invalidateQueries({ queryKey: ["candles", product] });
      };
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "heartbeat") heartbeat = Date.now();
        if (msg.type === "ticker") {
          const age = Date.now() - Date.parse(msg.time);
          ticker = Date.now();
          retry = 0;
          setFeed({
            status: age < 30000 && age >= -5000 ? "LIVE" : "STALE",
            price: Number(msg.price),
            time: msg.time,
            source: msg.source_product,
            received: Date.now(),
          });
          client.invalidateQueries({
            queryKey: ["candles", product],
            refetchType: "none",
          });
        }
        if (msg.type === "status")
          setFeed((s) => ({ ...s, status: msg.status }));
        if (msg.type === "reconcile") {
          setFeed((s) => ({ ...s, status: "STALE" }));
          client.invalidateQueries({ queryKey: ["candles", product] });
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (!stopped) {
          setFeed((s) => ({ ...s, status: "DISCONNECTED" }));
          timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 30000));
        }
      };
    };
    connect();
    const check = setInterval(() => {
      if (
        ticker &&
        (Date.now() - ticker > 30000 || Date.now() - heartbeat > 12000)
      )
        setFeed((s) => ({
          ...s,
          status: s.status === "DISCONNECTED" ? "DISCONNECTED" : "STALE",
        }));
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(check);
      socket?.close();
    };
  }, [product, client]);
  return feed;
}
