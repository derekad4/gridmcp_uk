import { useEffect, useState, useSyncExternalStore } from "react";
import { getInstallPrompt, isStandalone, needsManualInstall, promptInstall, subscribeInstallPrompt } from "@/lib/pwa";

export function useInstallPrompt() {
  const prompt = useSyncExternalStore(subscribeInstallPrompt, getInstallPrompt, () => null);
  const [installed, setInstalled] = useState(() => typeof window !== "undefined" && isStandalone());
  const manual = !installed && !prompt && typeof window !== "undefined" && needsManualInstall();
  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(isStandalone());
    media.addEventListener("change", update);
    window.addEventListener("appinstalled", update);
    return () => { media.removeEventListener("change", update); window.removeEventListener("appinstalled", update); };
  }, []);
  return { canPrompt: !installed && Boolean(prompt), manual, install: promptInstall };
}

export function useOnline() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("online", listener);
      window.addEventListener("offline", listener);
      return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
    },
    () => navigator.onLine,
    () => true,
  );
}
