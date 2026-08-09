import { createConnection } from "./db";

export function findSession(sessions: { id: string }[], id: string) {
  return sessions.find((s) => s.id == id);
}

export function newSessionToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function loadSession(userId: string) {
  const db = createConnection();
  try {
    return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");
  } catch (e) {
  }
}
