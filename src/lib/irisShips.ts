// IS IRIS IN THE INSTALLER? (Jeff, 2026-10-30: "Hide the IRIS button until Iris ships with the installer. Don't remove
// its code.") Iris is a separate app; the installer does not include it and Ether does not start it, so on a customer's
// computer the IRIS panel could only say "offline". Flip this to true in the same change that packages Iris.
export const IRIS_SHIPS_WITH_INSTALLER = false;
