import { createContext, useContext } from "react";

export interface AppUser {
  id: number;
  name: string;
  role: "admin" | "jock" | "music_director";
  pin_hash: string | null;
  color: string;
}

export const UserContext = createContext<AppUser | null>(null);

export function useUser() {
  return useContext(UserContext);
}

export function useRole() {
  const user = useContext(UserContext);
  return user?.role || "jock";
}

export function useCanEdit() {
  const role = useRole();
  return role === "admin" || role === "music_director";
}

export function useCanManageSpots() {
  const role = useRole();
  return role === "admin" || role === "music_director";
}

// Granular permissions for role-based layout gating
export function useCanAccessSettings() {
  return useRole() === "admin";
}
export function useCanAccessScheduler() {
  const role = useRole();
  return role === "admin" || role === "music_director";
}
export function useCanAccessMacros() {
  return useRole() === "admin";
}
export function useCanAccessStudio() {
  const role = useRole();
  return role === "admin" || role === "music_director";
}
export function useCanAccessStreaming() {
  return useRole() === "admin";
}
export function useCanDeleteTracks() {
  const role = useRole();
  return role === "admin" || role === "music_director";
}
