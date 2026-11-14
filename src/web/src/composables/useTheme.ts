import { getCurrentScope, onScopeDispose, readonly, shallowRef } from "vue";

export type ThemePreference = "light" | "dark" | "system";
export interface ThemeSnapshot {
  preference: ThemePreference;
  appearance: "light" | "dark";
  persistent: boolean;
}
interface ThemeController {
  getSnapshot(): ThemeSnapshot;
  setPreference(value: ThemePreference): void;
  subscribe(listener: (snapshot: ThemeSnapshot) => void): () => void;
}

/** 只读投影：首帧脚本拥有偏好、系统监听和存储；此处不再解析或另存主题。 */
export function useTheme() {
  const controller = (globalThis as typeof globalThis & { __boardroomTheme?: ThemeController }).__boardroomTheme;
  const snapshot = shallowRef<ThemeSnapshot>(controller?.getSnapshot() ?? { preference: "system", appearance: "light", persistent: false });
  const unsubscribe = controller?.subscribe((value) => { snapshot.value = value; });
  if (unsubscribe && getCurrentScope()) onScopeDispose(unsubscribe);
  return { snapshot: readonly(snapshot), available: !!controller,
    setPreference: (value: ThemePreference) => { controller?.setPreference(value); } };
}
