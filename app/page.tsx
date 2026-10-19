"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getApiKey } from "@/lib/db";

// Стартова сторінка: ведемо до чату, якщо ключ уже збережено, інакше до налаштування.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    getApiKey()
      .then((key) => router.replace(key ? "/chat" : "/setup"))
      .catch(() => router.replace("/setup"));
  }, [router]);

  return <main className="screen" />;
}
