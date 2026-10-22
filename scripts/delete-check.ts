// Перевірка видалення на пам'яті (fake-indexeddb): розмова і проєкт видаляються разом з даними.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import {
  addMessage,
  createConversation,
  createProject,
  deleteConversation,
  deleteProject,
  getFileBlob,
  getMessages,
  listConversations,
  listProjects,
  saveFile,
} from "../lib/db";

async function main(): Promise<void> {
  const p1 = await createProject("Видаляємо");
  const p2 = await createProject("Лишається");
  const c1 = await createConversation("Розмова 1", p1.id, "m");
  const c2 = await createConversation("Розмова 2", p1.id, "m");
  const c3 = await createConversation("Інша", p2.id, "m");
  await addMessage(c1.id, "user", "a");
  const file = await saveFile("t.xlsx", new Blob(["x"]));
  await addMessage(c1.id, "assistant", "b", undefined, [file]);
  await addMessage(c2.id, "user", "c");
  await addMessage(c3.id, "user", "d");

  await deleteConversation(c2.id);
  assert.equal((await getMessages(c2.id)).length, 0, "повідомлення видаленої розмови мають зникнути");
  assert.ok((await listConversations(p1.id)).some((c) => c.id === c1.id), "інша розмова проєкту лишається");
  console.log("PASS  видалення розмови прибирає її повідомлення, інші розмови лишаються");

  await deleteProject(p1.id);
  assert.ok(!(await listProjects()).some((p) => p.id === p1.id), "проєкт має зникнути");
  assert.equal((await getMessages(c1.id)).length, 0, "розмови проєкту мають зникнути");
  assert.equal(await getFileBlob(file.id), null, "файли розмов проєкту мають зникнути");
  assert.ok((await listProjects()).some((p) => p.id === p2.id), "інший проєкт лишається");
  assert.equal((await getMessages(c3.id)).length, 1, "розмова іншого проєкту лишається з повідомленнями");
  console.log("PASS  видалення проєкту прибирає розмови, повідомлення і файли, інший проєкт не зачіпає");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
