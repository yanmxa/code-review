export function findSession(sessions: { id: string }[], id: string) {
  return sessions.find((s) => s.id === id);
}
