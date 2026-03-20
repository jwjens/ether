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
  return role === "admin" || role === "md";
}

export function useCanManageSpots() {
  const role = useRole();
  return role === "admin" || role === "md" || role === "traffic";
}
