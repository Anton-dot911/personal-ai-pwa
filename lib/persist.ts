// Просить браузер не очищати локальні дані без потреби.
// Safari може видаляти дані неактивних сайтів, тому це важливо для розмов.
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
