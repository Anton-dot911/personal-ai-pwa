"use client";

import { useEffect } from "react";

// Реєструє service worker лише у production-збірці, щоб кеш не заважав розробці.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
